import type { LatencyBreakdown, TokenUsage } from './usage';

/**
 * Modo en el que se respondió: es el peldaño de la escalera de degradación que se usó.
 *  - `normal`: modelo primario.
 *  - `fallback_model`: el primario falló o venció su plazo; respondió el modelo de respaldo.
 *  - `rag_only`: ningún modelo respondió; se devuelven los pasajes recuperados, citados, sin
 *    redacción del modelo. Es una respuesta peor, pero es verdadera y útil.
 *  - `cached`: respuesta idéntica servida desde la caché.
 * Si tampoco hay pasajes, no hay cuarto peldaño: se responde 503 en vez de inventar.
 */
export type AnswerMode = 'normal' | 'fallback_model' | 'rag_only' | 'cached';

export interface Citation {
  /** Número que aparece en el texto como `[KB-n]`. */
  index: number;
  docId: string;
  title: string;
  section: string;
  /** Similitud del pasaje con la pregunta (0–1). */
  score: number;
  excerpt: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  /** Mensaje corto cuando `ok` es false; nunca el cuerpo completo del error. */
  error?: string;
}

export interface AgentAnswer {
  answer: string;
  citations: Citation[];
  toolCalls: ToolCallRecord[];
  usage: TokenUsage & { costUsd: number };
  latency: LatencyBreakdown;
  mode: AnswerMode;
  model: string;
  /** Señales no fatales: inyección detectada, cita inválida eliminada, secreto redactado… */
  flags: string[];
  validationPassed: boolean;
}
