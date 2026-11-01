/**
 * Uso y costo de una consulta. Se reportan **por tramo** porque "la IA está lenta" no es
 * accionable: lo que se puede atacar es "la recuperación tardó 40 ms y el bucle de tools hizo
 * siete llamadas". Los tokens de razonamiento van aparte porque Gemini los cobra aparte y no
 * aparecen en la respuesta visible.
 */

export interface TokenUsage {
  input: number;
  output: number;
  thinking: number;
  embedding: number;
}

export interface LatencyBreakdown {
  totalMs: number;
  retrievalMs: number;
  llmMs: number;
  toolsMs: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, thinking: 0, embedding: 0 };

export function addUsage(a: TokenUsage, b: Partial<TokenUsage>): TokenUsage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    thinking: a.thinking + (b.thinking ?? 0),
    embedding: a.embedding + (b.embedding ?? 0),
  };
}

/** Precios por millón de tokens. Son configuración: cambian sin avisar y no van fijos en código. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  embeddingPerMillion: number;
}

/**
 * Los tokens de razonamiento se facturan como salida: contarlos como entrada subestimaría el
 * costo de un modelo que piensa mucho, que es justo el que hay que vigilar.
 */
export function estimateCostUsd(usage: TokenUsage, pricing: ModelPricing): number {
  const usd =
    (usage.input * pricing.inputPerMillion + (usage.output + usage.thinking) * pricing.outputPerMillion + usage.embedding * pricing.embeddingPerMillion) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export const totalTokens = (usage: TokenUsage): number => usage.input + usage.output + usage.thinking + usage.embedding;
