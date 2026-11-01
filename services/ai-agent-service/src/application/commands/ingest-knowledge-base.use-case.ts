import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
  KNOWLEDGE_SOURCE,
  type KnowledgeSource,
  type StoredChunk,
  VECTOR_STORE,
  type VectorStore,
} from '../../domain/ports';

export interface IngestResult {
  totalChunks: number;
  embedded: number;
  skipped: number;
  deleted: number;
  embeddingTokens: number;
  durationMs: number;
}

const BATCH_SIZE = 20;

/**
 * Indexa la base de conocimiento en el store vectorial.
 *
 * Es **idempotente por hash**: en cada arranque se comparan los hashes de los chunks con los ya
 * indexados y solo se embeben los que cambiaron. Reiniciar el contenedor cuesta cero llamadas al
 * proveedor de embeddings, que es justo lo que uno quiere con una cuota gratuita y con un
 * servicio que puede reiniciarse varias veces en un despliegue.
 *
 * **El hash cubre el modelo y la dimensión, no solo el texto**, y esa es la parte que no es
 * obvia: un vector solo significa algo dentro del espacio del modelo que lo produjo. Dos modelos
 * distintos de 768 dimensiones —`gemini-embedding-001` y el proveedor mock, por ejemplo— generan
 * espacios incompatibles, así que consultar uno con vectores del otro devuelve ruido: ni un
 * error, ni una excepción, solo un asistente que contesta "no lo sé" a todo. Incluyendo el modelo
 * en el hash, cambiarlo invalida el índice entero y se reconstruye solo.
 *
 * Los lotes son de 20 por la misma razón: una llamada por chunk gasta cuota en handshakes.
 */
@Injectable()
export class IngestKnowledgeBaseUseCase {
  constructor(
    @Inject(KNOWLEDGE_SOURCE) private readonly source: KnowledgeSource,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
  ) {}

  async execute(options: { force?: boolean } = {}): Promise<IngestResult> {
    const started = Date.now();
    await this.store.ensureCollection(this.embeddings.dimensions);

    const space = `${this.embeddings.model}:${this.embeddings.dimensions}`;
    const chunks: StoredChunk[] = (await this.source.load()).map((chunk) => ({
      ...chunk,
      contentHash: createHash('sha256').update(`${space}\n${chunk.text}`).digest('hex').slice(0, 32),
    }));

    const indexed = options.force ? new Map<string, string>() : await this.store.indexedHashes();
    const pending = chunks.filter((chunk) => indexed.get(chunk.id) !== chunk.contentHash);

    let embeddingTokens = 0;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const result = await this.embeddings.embed(
        batch.map((c) => c.text),
        'document',
      );
      embeddingTokens += result.tokens;
      await this.store.upsert(batch.map((chunk, j) => ({ chunk, vector: result.vectors[j] })));
    }

    // Un documento borrado del repositorio debe desaparecer de las respuestas, no quedarse
    // indexado para siempre citándose a sí mismo.
    const deleted = await this.store.deleteMissing(chunks.map((c) => c.id));

    return {
      totalChunks: chunks.length,
      embedded: pending.length,
      skipped: chunks.length - pending.length,
      deleted,
      embeddingTokens,
      durationMs: Date.now() - started,
    };
  }
}
