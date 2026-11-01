import type { AgentEventSink, AgentOptions, Clock } from '../../src/application/ports';
import { chunkDocument, parseFrontMatter } from '../../src/domain/knowledge/chunk';
import type {
  AnswerCache,
  EmbeddingProvider,
  EmbeddingResult,
  EmbeddingTask,
  LlmProvider,
  LlmRequest,
  LlmResult,
  RateDecision,
  RateLimiter,
  SearchHit,
  SearchOptions,
  StoredChunk,
  ToolGateway,
  ToolInvocation,
  VectorStore,
} from '../../src/domain/ports';
import { MockEmbeddingProvider } from '../../src/infrastructure/llm/mock-provider';

/**
 * Implementaciones en memoria de los puertos del agente, con el **mismo contrato** que las de
 * producción: el ACL se aplica dentro de la búsqueda (como en Qdrant), el limitador decide antes
 * de llamar al modelo y la caché guarda cadenas. Gracias a esto el caso de uso completo —RAG,
 * bucle de herramientas, escalera de degradación, validación— se prueba sin Docker, sin red y
 * sin API key.
 *
 * Aquí no hay mocks de librerías: hay otra implementación del mismo puerto.
 */

export class InMemoryVectorStore implements VectorStore {
  private points = new Map<string, { chunk: StoredChunk; vector: number[] }>();
  dimensions = 0;

  async ensureCollection(dimensions: number): Promise<void> {
    this.dimensions = dimensions;
  }

  async upsert(entries: Array<{ chunk: StoredChunk; vector: number[] }>): Promise<void> {
    for (const entry of entries) this.points.set(entry.chunk.id, entry);
  }

  async indexedHashes(): Promise<Map<string, string>> {
    return new Map([...this.points.values()].map(({ chunk }) => [chunk.id, chunk.contentHash]));
  }

  async deleteMissing(keepIds: readonly string[]): Promise<number> {
    const keep = new Set(keepIds);
    let deleted = 0;
    for (const id of [...this.points.keys()]) {
      if (keep.has(id)) continue;
      this.points.delete(id);
      deleted++;
    }
    return deleted;
  }

  /** El ACL se aplica aquí dentro, igual que el filtro de Qdrant: un pasaje prohibido no sale. */
  async search(vector: number[], options: SearchOptions): Promise<SearchHit[]> {
    return [...this.points.values()]
      .filter(({ chunk }) => chunk.requiredPermission === null || options.permissions.includes(chunk.requiredPermission))
      .map(({ chunk, vector: v }) => ({ chunk, score: cosine(vector, v) }))
      .filter((hit) => hit.score >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit);
  }

  async count(): Promise<number> {
    return this.points.size;
  }
}

const cosine = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

/** Proveedor guionizado: cada llamada devuelve el siguiente turno de la lista, o lanza. */
export class ScriptedLlmProvider implements LlmProvider {
  readonly primaryModel = 'scripted-primary';
  readonly fallbackModel = 'scripted-fallback';
  calls: Array<{ model: string; request: LlmRequest }> = [];

  constructor(private readonly script: Record<string, Array<Partial<LlmResult> | Error>>) {}

  async generate(request: LlmRequest, model: string): Promise<LlmResult> {
    this.calls.push({ model, request });
    const next = this.script[model]?.shift();
    if (next === undefined) throw new Error(`sin guion para ${model}`);
    if (next instanceof Error) throw next;
    return {
      text: next.text ?? '',
      toolRequests: next.toolRequests ?? [],
      usage: next.usage ?? { input: 10, output: 10, thinking: 0 },
      model,
      finishReason: next.finishReason ?? 'STOP',
    };
  }
}

export class FakeToolGateway implements ToolGateway {
  invocations: ToolInvocation[] = [];
  constructor(private readonly responses: Record<string, unknown | Error> = {}) {}

  async invoke(invocation: ToolInvocation): Promise<unknown> {
    this.invocations.push(invocation);
    const response = this.responses[invocation.name];
    if (response instanceof Error) throw response;
    return response ?? { ok: true };
  }
}

export class FakeRateLimiter implements RateLimiter {
  recorded: Array<{ userId: string; tokens: number }> = [];
  constructor(private decision: RateDecision = { allowed: true }) {}
  deny(decision: RateDecision): void {
    this.decision = decision;
  }
  async check(): Promise<RateDecision> {
    return this.decision;
  }
  async recordUsage(userId: string, tokens: number): Promise<void> {
    this.recorded.push({ userId, tokens });
  }
}

export class FakeAnswerCache implements AnswerCache {
  entries = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }
}

export class FakeEventSink implements AgentEventSink {
  published: Array<Parameters<AgentEventSink['queryCompleted']>[0]> = [];
  async queryCompleted(event: Parameters<AgentEventSink['queryCompleted']>[0]): Promise<void> {
    this.published.push(event);
  }
}

/** Reloj que avanza 10 ms por lectura: los tramos de latencia salen deterministas. */
export class FakeClock implements Clock {
  private t = 1_000;
  now(): number {
    this.t += 10;
    return this.t;
  }
}

export const testOptions = (overrides: Partial<AgentOptions> = {}): AgentOptions => ({
  promptVersion: 'agent-v2',
  canary: 'TEST-CANARY-0001',
  maxToolSteps: 4,
  maxOutputTokens: 512,
  retrievalLimit: 5,
  cacheTtlSeconds: 300,
  pricing: { inputPerMillion: 0.3, outputPerMillion: 2.5, embeddingPerMillion: 0.15 },
  ...overrides,
});

/** Base de conocimiento mínima con un documento público y uno restringido por ACL. */
export const TEST_DOCS: Array<{ file: string; raw: string }> = [
  {
    file: 'politica',
    raw: `---
title: Política de accesos
requiredPermission: none
---

# Política de accesos

## Quién puede suspender usuarios

Solo los administradores pueden suspender usuarios. Nadie puede suspenderse a sí mismo ni dejar
la plataforma sin administradores activos.`,
  },
  {
    file: 'auditoria',
    raw: `---
title: Auditoría
requiredPermission: audit:read
---

# Auditoría

## Accesos fallidos

Los intentos de acceso fallidos se registran con el tipo auth.login_failed y se consultan
filtrando por tipo y rango de fechas.`,
  },
];

/** Indexa `TEST_DOCS` con el proveedor de embeddings por hashing (determinista, sin red). */
export async function seededStore(embeddings: EmbeddingProvider = new MockEmbeddingProvider(64)): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore();
  await store.ensureCollection(embeddings.dimensions);
  for (const { file, raw } of TEST_DOCS) {
    const { attributes, body } = parseFrontMatter(raw);
    const chunks = chunkDocument({
      docId: file,
      title: attributes.title,
      requiredPermission: attributes.requiredPermission === 'none' ? null : attributes.requiredPermission,
      body,
    });
    const { vectors } = await embeddings.embed(
      chunks.map((c) => c.text),
      'document',
    );
    await store.upsert(chunks.map((chunk, i) => ({ chunk: { ...chunk, contentHash: `h-${chunk.id}` }, vector: vectors[i] })));
  }
  return store;
}

export class CountingEmbeddingProvider implements EmbeddingProvider {
  calls = 0;
  readonly model = 'counting';
  constructor(private readonly inner: EmbeddingProvider = new MockEmbeddingProvider(64)) {}
  get dimensions(): number {
    return this.inner.dimensions;
  }
  get minScore(): number {
    return this.inner.minScore;
  }
  async embed(texts: string[], task: EmbeddingTask): Promise<EmbeddingResult> {
    this.calls += texts.length;
    return this.inner.embed(texts, task);
  }
}
