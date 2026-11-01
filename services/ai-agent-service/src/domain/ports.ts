import type { Chunk } from './knowledge/chunk';
import type { TokenUsage } from './answer/usage';

/**
 * Puertos del agente. El dominio declara QUÉ necesita; `infrastructure` decide CÓMO: Gemini o el
 * proveedor mock, Qdrant, los microservicios por HTTP, Redis. Gracias a esto el caso de uso que
 * orquesta el RAG y el bucle de tools se prueba entero, sin red y sin API key.
 */

// --- Modelo de lenguaje -------------------------------------------------------

export interface LlmMessage {
  role: 'user' | 'model' | 'tool';
  /** Texto del turno; en un turno `tool` es el resultado serializado. */
  text?: string;
  /** Turno del modelo que pidió herramientas: se reenvía intacto en la siguiente llamada. */
  toolRequests?: ToolRequest[];
  /** Respuestas a las herramientas pedidas en el turno anterior. */
  toolResponses?: ToolResponse[];
}

export interface ToolRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Firma opaca que algunos proveedores adjuntan al turno en que pidieron la herramienta y
   * exigen de vuelta al reenviarlo (Gemini 3: `thoughtSignature`). El dominio no sabe qué
   * contiene ni la interpreta; solo garantiza que viaja de ida y vuelta sin tocarse. Sin esto,
   * "reenviar el turno del modelo intacto" se queda en reenviarlo *casi* intacto, y el
   * proveedor responde 400.
   */
  signature?: string;
}

export interface ToolResponse {
  id: string;
  name: string;
  result: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  systemPrompt: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
}

export interface LlmResult {
  text: string;
  toolRequests: ToolRequest[];
  usage: Pick<TokenUsage, 'input' | 'output' | 'thinking'>;
  /** Modelo que respondió de verdad (puede no ser el pedido si el adaptador degradó). */
  model: string;
  finishReason: string | null;
}

export interface LlmProvider {
  /** Nombre del modelo primario, para reportarlo sin hacer una llamada. */
  readonly primaryModel: string;
  readonly fallbackModel: string;
  /** `model` elige el peldaño: lo decide el caso de uso, no el adaptador. */
  generate(request: LlmRequest, model: string): Promise<LlmResult>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

// --- Embeddings y vectores ----------------------------------------------------

export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /**
   * Similitud mínima para considerar relevante un pasaje, **en el espacio de este modelo**.
   * Vive aquí y no en la configuración general porque no es una preferencia del sistema sino una
   * propiedad del modelo: un embedding semántico y uno léxico no producen la misma escala, así
   * que un único umbral compartido descarta aciertos en uno o cuela ruido en el otro.
   */
  readonly minScore: number;
  embed(texts: string[], task: EmbeddingTask): Promise<EmbeddingResult>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface StoredChunk extends Chunk {
  /** Hash del texto: permite reindexar solo lo que cambió. */
  contentHash: string;
}

export interface SearchHit {
  chunk: StoredChunk;
  score: number;
}

export interface SearchOptions {
  limit: number;
  /**
   * Permisos del usuario. El store **debe** devolver solo pasajes públicos o cuyo
   * `requiredPermission` esté en esta lista: el ACL se aplica en la consulta, no filtrando
   * después, para que un pasaje prohibido nunca llegue a estar en memoria del proceso.
   */
  permissions: readonly string[];
  /** Puntuación mínima: por debajo, el pasaje no se considera relevante y no se cita. */
  minScore: number;
}

export interface VectorStore {
  ensureCollection(dimensions: number): Promise<void>;
  upsert(chunks: Array<{ chunk: StoredChunk; vector: number[] }>): Promise<void>;
  /** Hashes ya indexados, por id de chunk: la ingesta salta lo que no cambió. */
  indexedHashes(): Promise<Map<string, string>>;
  deleteMissing(keepIds: readonly string[]): Promise<number>;
  search(vector: number[], options: SearchOptions): Promise<SearchHit[]>;
  count(): Promise<number>;
}

export const VECTOR_STORE = Symbol('VECTOR_STORE');

// --- Herramientas sobre los microservicios -----------------------------------

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  /** Token del usuario: se reenvía tal cual para que el servicio destino vuelva a autorizar. */
  accessToken: string;
}

export interface ToolGateway {
  invoke(invocation: ToolInvocation): Promise<unknown>;
}

export const TOOL_GATEWAY = Symbol('TOOL_GATEWAY');

// --- Límites y caché ----------------------------------------------------------

export interface RateDecision {
  allowed: boolean;
  /** Qué límite se agotó: sirve para decirle al usuario si es suyo o del sistema. */
  scope?: 'global_rpm' | 'global_rpd' | 'user_rpm' | 'user_daily_tokens';
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  /** Se consulta ANTES de llamar al modelo. No consume tokens: solo cuenta peticiones. */
  check(userId: string): Promise<RateDecision>;
  /** Se registra DESPUÉS, con el gasto real: los tokens no se conocen hasta responder. */
  recordUsage(userId: string, tokens: number): Promise<void>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const ANSWER_CACHE = Symbol('ANSWER_CACHE');

// --- Base de conocimiento -----------------------------------------------------

export interface KnowledgeSource {
  load(): Promise<Chunk[]>;
}

export const KNOWLEDGE_SOURCE = Symbol('KNOWLEDGE_SOURCE');
