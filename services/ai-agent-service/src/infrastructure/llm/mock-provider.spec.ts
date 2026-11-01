import { MockEmbeddingProvider, MockLlmProvider } from './mock-provider';
import type { LlmRequest } from '../../domain/ports';

const TOOLS = ['get_user_stats', 'get_audit_stats', 'get_audit_events', 'list_roles', 'search_users'].map((name) => ({
  name,
  description: '',
  parameters: {},
}));

const ask = (question: string, tools = TOOLS): LlmRequest => ({
  systemPrompt: 'sistema',
  messages: [{ role: 'user', text: `<contexto>\n(sin pasajes relevantes)\n</contexto>\n\nPregunta del usuario: ${question}` }],
  tools,
  maxOutputTokens: 256,
});

describe('proveedor mock · detección de intención', () => {
  const llm = new MockLlmProvider();

  /**
   * El caso que costó un fallo del golden set: `\b` se define sobre `[A-Za-z0-9_]`, así que la
   * posición después de "é" no es un límite de palabra y `/\bqué\b/` no casa nunca. "Cuántos"
   * funcionaba —termina en "s"— y "Qué" no, lo que hacía el fallo difícil de ver.
   */
  it('reconoce preguntas que empiezan por una palabra acentuada', async () => {
    const result = await llm.generate(ask('¿Qué roles existen en la plataforma?'), 'm');
    expect(result.toolRequests.map((t) => t.name)).toEqual(['list_roles']);
  });

  it('reconoce las demás intenciones de datos en vivo', async () => {
    const casos: Array<[string, string]> = [
      ['¿Cuántos usuarios activos hay?', 'get_user_stats'],
      ['Busca los usuarios suspendidos', 'search_users'],
      ['Dame un reporte de accesos fallidos', 'get_audit_events'],
    ];
    for (const [pregunta, esperada] of casos) {
      const result = await llm.generate(ask(pregunta), 'm');
      expect(result.toolRequests.map((t) => t.name)).toEqual([esperada]);
    }
  });

  it('no pide una herramienta que no se le ofreció', async () => {
    const result = await llm.generate(ask('¿Qué roles existen?', []), 'm');
    expect(result.toolRequests).toHaveLength(0);
  });

  it('una pregunta de política no dispara ninguna herramienta', async () => {
    const result = await llm.generate(ask('¿Quién puede suspender a un usuario?'), 'm');
    expect(result.toolRequests).toHaveLength(0);
  });
});

describe('proveedor mock · embeddings', () => {
  it('es determinista y normalizado', async () => {
    const p = new MockEmbeddingProvider(64);
    const a = await p.embed(['política de accesos'], 'document');
    const b = await p.embed(['política de accesos'], 'query');
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    const magnitud = Math.sqrt(a.vectors[0].reduce((s, v) => s + v * v, 0));
    expect(magnitud).toBeCloseTo(1, 6);
  });

  it('declara un umbral propio, más bajo que el de un embedding semántico', () => {
    // No es un capricho: medido contra la base de conocimiento real, los aciertos de este
    // embedding léxico caen entre 0.30 y 0.42, por debajo del 0.35 pensado para Gemini.
    expect(new MockEmbeddingProvider().minScore).toBeLessThan(0.35);
  });
});
