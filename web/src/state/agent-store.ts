import { create } from 'zustand';
import { agentApi, type AgentAnswer, type AgentCapabilities } from '@/services/agent-api';
import { describeProblem, problemCode, retryAfterSeconds } from '@/lib/problem';

export interface Turn {
  id: string;
  question: string;
  /** `null` mientras se espera la respuesta. */
  answer: AgentAnswer | null;
  error: { message: string; code: string | null; retryAfterSeconds: number | null } | null;
}

interface AgentState {
  turns: Turn[];
  pending: boolean;
  capabilities: AgentCapabilities | null;
  ask: (question: string) => Promise<void>;
  loadCapabilities: () => Promise<void>;
  reset: () => void;
}

/**
 * La conversación vive solo en memoria de la pestaña y se pierde al recargar. Es deliberado:
 * las preguntas pueden incluir nombres de personas y el servicio no guarda ni la pregunta ni la
 * respuesta (solo un hash). Persistirlas en el navegador crearía la copia que el backend
 * decidió no tener.
 */
export const useAgentStore = create<AgentState>((set, get) => ({
  turns: [],
  pending: false,
  capabilities: null,

  ask: async (question: string) => {
    if (get().pending) return;
    const id = `${Date.now()}-${get().turns.length}`;
    set({ pending: true, turns: [...get().turns, { id, question, answer: null, error: null }] });

    const patch = (turn: Partial<Turn>) =>
      set({ pending: false, turns: get().turns.map((t) => (t.id === id ? { ...t, ...turn } : t)) });

    try {
      patch({ answer: await agentApi.query(question) });
    } catch (error) {
      patch({
        error: { message: describeProblem(error), code: problemCode(error), retryAfterSeconds: retryAfterSeconds(error) },
      });
    }
  },

  loadCapabilities: async () => {
    try {
      set({ capabilities: await agentApi.capabilities() });
    } catch {
      set({ capabilities: null });
    }
  },

  reset: () => set({ turns: [], pending: false }),
}));
