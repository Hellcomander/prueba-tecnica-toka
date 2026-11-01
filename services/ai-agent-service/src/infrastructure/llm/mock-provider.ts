import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EmbeddingProvider, EmbeddingResult, EmbeddingTask, LlmProvider, LlmRequest, LlmResult, ToolRequest } from '../../domain/ports';

/**
 * Proveedor mock: **no** es un stub que devuelve "ok". Es el que hace que todo lo demás —la
 * recuperación, el ACL, el bucle de tools, el validador, los límites, la interfaz— sea
 * ejecutable y evaluable **sin API key y sin red**, que es como va a llegar este repositorio a
 * quien lo revise. También es lo que hace que el golden set sea determinista: con un modelo real,
 * la misma pregunta da textos distintos y el test se vuelve inútil.
 *
 * Lo que imita, y hasta dónde:
 *  - **Intenciones por palabras clave** → decide si pedir una herramienta o responder con el
 *    contexto. No entiende la pregunta; reconoce el caso.
 *  - **Citas reales**: cita los pasajes que de verdad recibió, así el validador trabaja de
 *    verdad en lugar de ver siempre una respuesta sin citas.
 *  - **Lo que NO imita**: redacción, razonamiento y matices. Un golden set que pase en mock no
 *    demuestra calidad de respuesta, solo que la mecánica funciona. La calidad se mide en vivo
 *    (ver `docs/ai/evaluation.md`).
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly primaryModel = 'mock-flash';
  readonly fallbackModel = 'mock-flash-lite';

  async generate(request: LlmRequest, model: string): Promise<LlmResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const question = extractQuestion(lastUser?.text ?? '');
    const passages = extractPassages(lastUser?.text ?? '');
    const toolResults = request.messages.flatMap((m) => m.toolResponses ?? []);
    const available = new Set(request.tools.map((t) => t.name));
    const usage = { input: estimate(request), output: 0, thinking: 0 };

    // Primero se decide si hace falta una herramienta; si ya hay resultados, se redacta con ellos.
    if (toolResults.length === 0) {
      const wanted = chooseTool(question, available);
      if (wanted) {
        return { text: '', toolRequests: [wanted], usage: { ...usage, output: 8 }, model, finishReason: 'TOOL_CALL' };
      }
    }

    const text = compose(question, passages, toolResults, request.systemPrompt);
    return { text, toolRequests: [], usage: { ...usage, output: Math.ceil(text.length / 4) }, model, finishReason: 'STOP' };
  }
}

/** Embeddings deterministas por hashing: misma entrada, mismo vector, sin red y sin costo. */
@Injectable()
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'mock-embedding';
  readonly dimensions: number;
  /**
   * Más bajo que el de Gemini (0.35 por defecto) y no por capricho: medido contra la base de
   * conocimiento real, los aciertos de este embedding léxico caen entre 0.30 y 0.42 y el ruido
   * por debajo de 0.20. Con el umbral pensado para un embedding semántico se descartaban
   * respuestas correctas —"¿Se pueden borrar usuarios?" acertaba el pasaje con 0.307 y se
   * filtraba—. Es la razón de que el umbral viva en el proveedor y no en la configuración.
   */
  readonly minScore: number;

  constructor(dimensions = 768, minScore = 0.25) {
    this.dimensions = dimensions;
    this.minScore = minScore;
  }

  async embed(texts: string[], _task: EmbeddingTask): Promise<EmbeddingResult> {
    return { vectors: texts.map((text) => hashVector(text, this.dimensions)), tokens: Math.ceil(texts.join(' ').length / 4) };
  }
}

/**
 * Vector por bolsa de palabras con hashing: cada palabra suma peso en una dimensión fija. Dos
 * textos que comparten vocabulario quedan cerca en coseno, que es lo que la recuperación
 * necesita para ser creíble en modo mock.
 */
export function hashVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  for (const word of words) {
    const digest = createHash('sha256').update(word).digest();
    vector[digest.readUInt32BE(0) % dimensions] += 1;
    vector[digest.readUInt32BE(4) % dimensions] += 0.5;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return magnitude > 0 ? vector.map((v) => v / magnitude) : vector;
}

/**
 * Límite de palabra consciente de Unicode. **`\b` no sirve aquí**: en JavaScript se define sobre
 * `[A-Za-z0-9_]`, así que la posición después de una vocal acentuada no es un límite de palabra
 * y `/\bqué\b/` no casa nunca con "¿Qué roles existen?". Costó un caso del golden set: la
 * herramienta `list_roles` no se disparaba mientras `get_user_stats` sí, porque "Cuántos"
 * termina en una letra ASCII y "Qué" no.
 */
const w = (body: string) => new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, 'iu');

const TOOL_INTENTS: Array<{ tool: string; pattern: RegExp; args?: (q: string) => Record<string, unknown> }> = [
  { tool: 'get_user_stats', pattern: w('(?:cu[aá]ntos|n[uú]mero de|total de)[^?]*usuarios?') },
  { tool: 'get_audit_stats', pattern: w('(?:cu[aá]ntos|total de)[^?]*(?:eventos?|registros?)') },
  { tool: 'get_audit_events', pattern: w('(?:auditor[ií]a|accesos? fallidos?|intentos? fallidos?|inicios? de sesi[oó]n|reporte de accesos?)'), args: () => ({ limit: 20 }) },
  { tool: 'list_roles', pattern: w('(?:qu[eé]|cu[aá]les|lista de)[^?]*roles?') },
  { tool: 'search_users', pattern: w('(?:busca|lista|mu[eé]strame)[^?]*usuarios?'), args: () => ({ pageSize: 20 }) },
];

function chooseTool(question: string, available: ReadonlySet<string>): ToolRequest | null {
  for (const intent of TOOL_INTENTS) {
    if (intent.pattern.test(question) && available.has(intent.tool)) {
      return { id: `mock-${intent.tool}`, name: intent.tool, args: intent.args?.(question) ?? {} };
    }
  }
  return null;
}

function compose(question: string, passages: string[], toolResults: Array<{ name: string; result: unknown }>, systemPrompt: string): string {
  if (/\b(ignora|olvida)\b.*\b(instrucciones|reglas)\b|\b(system prompt|tus instrucciones)\b/i.test(question)) {
    return 'No puedo compartir mis instrucciones internas. Puedo ayudarte con usuarios, roles, permisos y auditoría de la plataforma.';
  }
  if (toolResults.length > 0) {
    const lines = toolResults.map((r) => `- ${r.name}: ${summarize(r.result)}`);
    return `Según los datos en vivo de la plataforma:\n${lines.join('\n')}`;
  }
  if (passages.length === 0) {
    return 'No lo sé. No encontré nada en la base de conocimiento que responda a eso, y no tengo una herramienta que pueda consultarlo.';
  }
  void systemPrompt;
  const cites = passages.slice(0, 2).map((_, i) => `[KB-${i + 1}]`).join('');
  return `${firstSentences(passages[0], 2)} ${cites}`;
}

function summarize(result: unknown): string {
  if (result === null || typeof result !== 'object') return String(result);
  const entries = Object.entries(result as Record<string, unknown>).slice(0, 6);
  return entries.map(([k, v]) => `${k}=${Array.isArray(v) ? `${v.length} elemento(s)` : typeof v === 'object' ? '{…}' : String(v)}`).join(', ');
}

function firstSentences(text: string, count: number): string {
  const body = text.replace(/^[^\n]*\n/, '').replace(/\s+/g, ' ').trim();
  const sentences = body.split(/(?<=\.)\s+/).slice(0, count).join(' ');
  return sentences || body.slice(0, 240);
}

function extractQuestion(turn: string): string {
  const match = /Pregunta del usuario:\s*([\s\S]*)$/.exec(turn);
  return (match ? match[1] : turn).trim();
}

function extractPassages(turn: string): string[] {
  const block = /<contexto>\n([\s\S]*?)\n<\/contexto>/.exec(turn);
  if (!block || block[1].startsWith('(sin pasajes')) return [];
  return block[1].split(/\n\n(?=\[KB-\d+\])/).map((p) => p.replace(/^\[KB-\d+\]\s*\([^)]*\)\n/, '').trim());
}

const estimate = (request: LlmRequest): number =>
  Math.ceil((request.systemPrompt.length + request.messages.reduce((n, m) => n + (m.text?.length ?? 0), 0)) / 4);
