// Spike de F0: confirma contra la API real de Gemini lo que el agente de IA asume.
//   npm run spike:gemini            -> modelos, 1 llamada con tool, 1 embedding, conteo de tokens
//   npm run spike:gemini -- --burst -> además, ráfaga corta para observar la forma del 429
// Lee GEMINI_API_KEY de .env (node --env-file-if-exists). Nunca imprime la key.
// Solo envía datos sintéticos: en el free tier Google puede usar los prompts.
import { GoogleGenAI } from '@google/genai';

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  console.error('GEMINI_API_KEY no está definida (.env). El stack funciona igual en modo mock.');
  process.exit(1);
}
const burst = process.argv.includes('--burst');
const ai = new GoogleGenAI({ apiKey: key, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });
const out = { models: {}, toolCall: null, embedding: null, countTokens: null, rateLimit: null };

function pickError(e) {
  const err = /** @type {any} */ (e);
  let body = err?.message ?? String(err);
  try {
    body = JSON.parse(body.slice(body.indexOf('{')));
  } catch {
    /* mensaje no JSON */
  }
  return { status: err?.status ?? err?.code, body };
}

// 1) Modelos disponibles para esta key
const gen = [];
const emb = [];
for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
  const actions = m.supportedActions ?? [];
  if (actions.includes('generateContent')) gen.push({ name: m.name, in: m.inputTokenLimit, out: m.outputTokenLimit, thinking: m.thinking });
  if (actions.includes('embedContent')) emb.push({ name: m.name, in: m.inputTokenLimit });
}
out.models = { generate: gen.map((m) => m.name), embed: emb.map((m) => m.name) };

const chatModel = process.env.GEMINI_MODEL || gen.map((m) => m.name.replace('models/', '')).find((n) => /flash/.test(n) && !/lite|image|tts|live|audio|preview|exp/.test(n));
const embedModel = process.env.GEMINI_EMBEDDING_MODEL || emb.map((m) => m.name.replace('models/', '')).find((n) => /embedding/.test(n));
out.chosen = { chatModel, embedModel };

// 2) Una llamada con function calling (datos sintéticos)
const tools = [
  {
    functionDeclarations: [
      {
        name: 'get_user_stats',
        description: 'Devuelve conteos de usuarios por estado (active, suspended).',
        parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  },
];
try {
  const t0 = Date.now();
  const r = await ai.models.generateContent({
    model: chatModel,
    contents: '¿Cuántos usuarios activos hay en la plataforma?',
    config: { tools, maxOutputTokens: 256, thinkingConfig: { thinkingLevel: 'low' } },
  });
  out.toolCall = {
    ms: Date.now() - t0,
    functionCalls: r.functionCalls?.map((f) => ({ name: f.name, args: f.args })) ?? [],
    finishReason: r.candidates?.[0]?.finishReason,
    usage: r.usageMetadata,
  };
} catch (e) {
  out.toolCall = { error: pickError(e) };
}

// 3) Un embedding
try {
  const t0 = Date.now();
  const r = await ai.models.embedContent({
    model: embedModel,
    contents: ['Política de acceso: solo los administradores pueden suspender usuarios.'],
    config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
  });
  out.embedding = { ms: Date.now() - t0, dims: r.embeddings?.[0]?.values?.length, metadata: r.metadata };
} catch (e) {
  out.embedding = { error: pickError(e) };
}

// 4) Conteo de tokens (base para estimar costo)
try {
  const r = await ai.models.countTokens({ model: chatModel, contents: 'Hola, ¿qué roles existen?' });
  out.countTokens = r;
} catch (e) {
  out.countTokens = { error: pickError(e) };
}

// 5) Forma del 429 (opcional): ráfaga corta, se detiene en el primer 429
if (burst) {
  const lite = process.env.GEMINI_FALLBACK_MODEL || chatModel;
  const calls = Array.from({ length: 30 }, () =>
    ai.models.generateContent({ model: lite, contents: 'di ok', config: { maxOutputTokens: 4 } }).then(
      () => null,
      (e) => pickError(e),
    ),
  );
  const errors = (await Promise.all(calls)).filter(Boolean);
  out.rateLimit = { model: lite, sent: calls.length, failed: errors.length, first: errors.find((e) => e.status === 429) ?? errors[0] ?? null };
}

console.log(JSON.stringify(out, null, 2));
