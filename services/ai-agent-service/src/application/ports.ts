import type { ModelPricing } from '../domain/answer/usage';
import type { PromptVersion } from './prompts/agent-prompt';

/** Publica `agent.query_completed`. No lanza: una consulta respondida no se tira por el broker. */
export interface AgentEventSink {
  queryCompleted(event: {
    userId: string;
    questionHash: string;
    toolsUsed: string[];
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    embeddingTokens: number;
    estimatedCostUsd: number;
    model: string;
    mode: 'normal' | 'fallback_model' | 'rag_only';
    cacheHit: boolean;
    validationPassed: boolean;
    flags: string[];
  }): Promise<void>;
}

export const AGENT_EVENT_SINK = Symbol('AGENT_EVENT_SINK');

/** Inyectable para que los tests midan tiempos sin esperar de verdad. */
export interface Clock {
  now(): number;
}

export const CLOCK = Symbol('CLOCK');

export interface AgentOptions {
  promptVersion: PromptVersion;
  /** Frase de control que nunca debe aparecer en una respuesta. */
  canary: string;
  maxToolSteps: number;
  maxOutputTokens: number;
  retrievalLimit: number;
  cacheTtlSeconds: number;
  pricing: ModelPricing;
}

export const AGENT_OPTIONS = Symbol('AGENT_OPTIONS');
