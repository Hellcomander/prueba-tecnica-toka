import { api } from '@/lib/api';

/** Espejo de `AgentAnswer` del servicio. Si cambia allí, esto tiene que cambiar aquí. */
export type AnswerMode = 'normal' | 'fallback_model' | 'rag_only' | 'cached';

export interface Citation {
  index: number;
  docId: string;
  title: string;
  section: string;
  score: number;
  excerpt: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  thinking: number;
  embedding: number;
  costUsd: number;
}

export interface AgentLatency {
  totalMs: number;
  retrievalMs: number;
  llmMs: number;
  toolsMs: number;
}

export interface AgentAnswer {
  answer: string;
  citations: Citation[];
  toolCalls: ToolCallRecord[];
  usage: AgentUsage;
  latency: AgentLatency;
  mode: AnswerMode;
  model: string;
  flags: string[];
  validationPassed: boolean;
}

export interface AgentCapabilities {
  provider: string;
  model: string;
  fallbackModel: string;
  embeddingModel: string;
  promptVersion: string;
  tools: Array<{ name: string; description: string; requiredPermission: string }>;
  knowledgeChunks: number;
}

export const agentApi = {
  query: async (question: string): Promise<AgentAnswer> => {
    const { data } = await api.post<AgentAnswer>('/agent/query', { question });
    return data;
  },
  capabilities: async (): Promise<AgentCapabilities> => {
    const { data } = await api.get<AgentCapabilities>('/agent/capabilities');
    return data;
  },
};
