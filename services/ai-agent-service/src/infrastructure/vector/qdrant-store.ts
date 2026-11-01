import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createHash } from 'node:crypto';
import type { SearchHit, SearchOptions, StoredChunk, VectorStore } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { ENV, type Env } from '../config/env';

/**
 * Store vectorial sobre Qdrant por HTTP (`fetch` nativo de Node 24: una dependencia menos que
 * auditar para cuatro llamadas REST).
 *
 * Lo importante de este adaptador es **dónde se aplica el ACL**: el permiso requerido de cada
 * pasaje viaja en el payload del punto y el filtro va **dentro de la consulta**, no después de
 * recibir los resultados. Un pasaje que el usuario no puede ver nunca llega a estar en memoria
 * de este proceso, así que no puede acabar en un log, en un mensaje de error ni en el prompt por
 * un descuido posterior.
 */
@Injectable()
export class QdrantVectorStore implements VectorStore {
  private readonly baseUrl: string;
  private readonly collection: string;

  constructor(
    @Inject(ENV) env: Env,
    @InjectPinoLogger(QdrantVectorStore.name) private readonly logger: PinoLogger,
  ) {
    this.baseUrl = env.QDRANT_URL.replace(/\/$/, '');
    this.collection = env.QDRANT_COLLECTION;
  }

  async ensureCollection(dimensions: number): Promise<void> {
    const existing = await this.request<{ result?: { config?: { params?: { vectors?: { size?: number } } } } }>('GET', `/collections/${this.collection}`, undefined, [
      200, 404,
    ]);
    const size = existing?.result?.config?.params?.vectors?.size;
    if (size === dimensions) return;
    if (size !== undefined && size !== dimensions) {
      // Un cambio de dimensión hace imposible siquiera guardar el vector, así que la colección se
      // recrea. El caso traicionero es el contrario —dos modelos distintos con la MISMA
      // dimensión— que Qdrant acepta sin quejarse y devuelve ruido; ese lo cubre el hash de la
      // ingesta, que incluye el modelo (ver IngestKnowledgeBaseUseCase).
      this.logger.warn({ event: 'kb.collection_recreated', from: size, to: dimensions }, 'kb.collection_recreated');
      await this.request('DELETE', `/collections/${this.collection}`, undefined, [200, 404]);
    }
    await this.request('PUT', `/collections/${this.collection}`, { vectors: { size: dimensions, distance: 'Cosine' } });
    await this.request('PUT', `/collections/${this.collection}/index`, { field_name: 'requiredPermission', field_schema: 'keyword' }, [200, 409]);
  }

  async upsert(entries: Array<{ chunk: StoredChunk; vector: number[] }>): Promise<void> {
    if (entries.length === 0) return;
    await this.request('PUT', `/collections/${this.collection}/points?wait=true`, {
      points: entries.map(({ chunk, vector }) => ({ id: pointId(chunk.id), vector, payload: { ...chunk } })),
    });
  }

  async indexedHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    let offset: unknown = undefined;
    do {
      const page = await this.request<{ result?: { points?: Array<{ payload?: StoredChunk }>; next_page_offset?: unknown } }>(
        'POST',
        `/collections/${this.collection}/points/scroll`,
        { limit: 256, with_payload: true, with_vector: false, ...(offset ? { offset } : {}) },
        [200, 404],
      );
      for (const point of page?.result?.points ?? []) {
        if (point.payload?.id && point.payload.contentHash) hashes.set(point.payload.id, point.payload.contentHash);
      }
      offset = page?.result?.next_page_offset ?? undefined;
    } while (offset);
    return hashes;
  }

  async deleteMissing(keepIds: readonly string[]): Promise<number> {
    const keep = new Set(keepIds);
    const stale = [...(await this.indexedHashes()).keys()].filter((id) => !keep.has(id));
    if (stale.length === 0) return 0;
    await this.request('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: stale.map(pointId) });
    return stale.length;
  }

  async search(vector: number[], options: SearchOptions): Promise<SearchHit[]> {
    const response = await this.request<{ result?: Array<{ score: number; payload?: StoredChunk }> }>('POST', `/collections/${this.collection}/points/search`, {
      vector,
      limit: options.limit,
      with_payload: true,
      score_threshold: options.minScore,
      filter: aclFilter(options.permissions),
    });
    return (response?.result ?? [])
      .filter((hit): hit is { score: number; payload: StoredChunk } => hit.payload !== undefined)
      .map((hit) => ({ chunk: hit.payload, score: hit.score }));
  }

  async count(): Promise<number> {
    const response = await this.request<{ result?: { count?: number } }>('POST', `/collections/${this.collection}/points/count`, { exact: true }, [200, 404]);
    return response?.result?.count ?? 0;
  }

  private async request<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200]): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new DomainError('VECTOR_STORE_UNAVAILABLE', 'unavailable', `Qdrant no respondió: ${(error as Error).message}`);
    }
    if (!okStatuses.includes(response.status)) {
      const detail = (await response.text()).slice(0, 300);
      throw new DomainError('VECTOR_STORE_ERROR', 'unavailable', `Qdrant respondió ${response.status}: ${detail}`);
    }
    if (response.status === 404) return null;
    return (await response.json()) as T;
  }
}

/**
 * Filtro ACL: un pasaje es visible si **no exige permiso** o si exige uno que el usuario tiene.
 *
 * Son dos condiciones en un `should` (OR), no una sola lista: `match.any` de Qdrant acepta
 * cadenas o enteros, y meter `null` dentro devuelve un 400 —`data did not match any variant of
 * untagged enum MatchInterface`—. La ausencia de permiso se expresa con `is_null`.
 *
 * Con la lista de permisos vacía queda solo la rama `is_null`: un usuario sin permisos ve
 * únicamente lo público, que es exactamente lo que debe pasar.
 */
export function aclFilter(permissions: readonly string[]): Record<string, unknown> {
  const should: Array<Record<string, unknown>> = [{ is_null: { key: 'requiredPermission' } }];
  if (permissions.length > 0) should.push({ key: 'requiredPermission', match: { any: [...permissions] } });
  return { should };
}

/** Qdrant acepta enteros o UUID como id; el id legible del chunk va en el payload. */
export function pointId(chunkId: string): string {
  const digest = createHash('sha1').update(chunkId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
