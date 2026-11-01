// Evaluación del agente contra el golden set, sobre el stack real.
//
//   npm run eval                    # corre los 12 casos y escribe el reporte
//   npm run eval -- --out docs/ai/reports/live-flash-lite.md
//   npm run eval -- --label "vivo · gemini-3.5-flash-lite"
//
// Funciona igual con el proveedor mock y con Gemini: lo que mide es la **mecánica** del agente
// (qué cita, qué herramienta usa, qué se le niega al viewer, qué señales levanta), no la
// redacción, que cambia en cada llamada de un modelo real. El modelo que respondió de verdad se
// registra por caso, así que un reporte nunca miente sobre con qué se midió.
//
// Requiere el stack con el override de desarrollo (puertos 13001-13005).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATEGORIES, GOLDEN_SET } from './eval/golden-set.mjs';

const AUTH = process.env.EVAL_AUTH_URL ?? 'http://127.0.0.1:13001';
const AGENT = process.env.EVAL_AGENT_URL ?? 'http://127.0.0.1:13005';

const SEED = {
  admin: { email: 'admin@toka.local', password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!demo' },
  auditor: { email: 'auditor@toka.local', password: process.env.SEED_AUDITOR_PASSWORD ?? 'Auditor123!demo' },
  viewer: { email: 'viewer@toka.local', password: process.env.SEED_VIEWER_PASSWORD ?? 'Viewer123!demo' },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ritmo entre casos. El agente limita a `AI_USER_RPM=4` por usuario y `AI_GLOBAL_RPM=8` en total,
 * así que lanzar doce preguntas seguidas provocaría 422 y mediría el limitador en vez del agente.
 * El runner se auto-regula y, si aun así recibe un 422, **respeta la cabecera `Retry-After`** en
 * lugar de reintentar a ciegas: es la misma regla que el propio agente aplica con el proveedor.
 */
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 8_000);

async function login(email, password) {
  const res = await fetch(`${AUTH}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

/**
 * Tope de espera. Respetar `Retry-After` es lo correcto, pero **no a ciegas**: un límite por
 * minuto manda 60 segundos y uno diario puede mandar cuatro horas. La primera versión de este
 * runner obedeció un `Retry-After: 15905` y se quedó dormido catorce minutos sin decir nada
 * hasta que alguien lo paró. Si la espera no cabe aquí, el caso se marca como no ejecutado y la
 * corrida sigue: un reporte incompleto y honesto es mejor que un proceso colgado.
 */
const MAX_WAIT_S = Number(process.env.EVAL_MAX_WAIT_S ?? 90);

/** Plazo por petición: el agente tiene sus propios timeouts, pero el runner no debe fiarse. */
const REQUEST_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 60_000);

async function ask(token, question) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${AGENT}/api/v1/agent/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ question, useCache: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, body: { code: err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' } };
    }
    if (res.ok) return { ok: true, body: await res.json() };

    const body = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 422 && body.code === 'AI_RATE_LIMITED' && attempt < 3) {
      if (!Number.isFinite(retryAfter) || retryAfter > MAX_WAIT_S) {
        process.stderr.write(`\n    límite alcanzado y la espera (${retryAfter || '?'} s) excede el tope de ${MAX_WAIT_S} s: ${body.detail ?? ''}\n`);
        return { ok: false, status: res.status, body: { ...body, code: 'AI_RATE_LIMITED_LONG' } };
      }
      process.stderr.write(`\n    (límite por minuto; esperando ${retryAfter} s como pide Retry-After)\n`);
      await sleep((retryAfter + 1) * 1_000);
      continue;
    }
    return { ok: false, status: res.status, body };
  }
  return { ok: false, status: 429, body: { code: 'AI_RATE_LIMITED' } };
}

/** Comprobaciones duras: hechos sobre la respuesta, no sobre su redacción. */
function hardChecks(expect, answer) {
  const checks = [];
  const citedDocs = answer.citations.map((c) => c.docId);
  const okTools = answer.toolCalls.filter((t) => t.ok).map((t) => t.name);
  const allTools = answer.toolCalls.map((t) => t.name);
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  if (expect.minCitations !== undefined) {
    add(`cita ≥ ${expect.minCitations}`, answer.citations.length >= expect.minCitations, `${answer.citations.length} cita(s)`);
  }
  if (expect.citesAnyOf) {
    const hit = citedDocs.filter((d) => expect.citesAnyOf.some((e) => d.includes(e)));
    add(`cita alguno de [${expect.citesAnyOf.join(', ')}]`, hit.length > 0, citedDocs.join(', ') || 'sin citas');
  }
  if (expect.neverCites) {
    const leak = citedDocs.filter((d) => expect.neverCites.some((e) => d.includes(e)));
    add(`nunca cita [${expect.neverCites.join(', ')}]`, leak.length === 0, leak.join(', ') || 'ninguno');
  }
  if (expect.usesTools) {
    const missing = expect.usesTools.filter((t) => !okTools.includes(t));
    add(`usa [${expect.usesTools.join(', ')}]`, missing.length === 0, okTools.join(', ') || 'ninguna');
  }
  if (expect.neverUsesTools) {
    const used = expect.neverUsesTools.filter((t) => allTools.includes(t));
    add(`nunca usa [${expect.neverUsesTools.join(', ')}]`, used.length === 0, used.join(', ') || 'ninguna');
  }
  if (expect.noTools) add('no usa herramientas', allTools.length === 0, allTools.join(', ') || 'ninguna');
  if (expect.flagsMatch) {
    for (const pattern of expect.flagsMatch) {
      const re = new RegExp(pattern);
      add(`señal /${pattern}/`, answer.flags.some((f) => re.test(f)), answer.flags.join(', ') || 'sin señales');
    }
  }
  if (expect.validationPassed) add('validación de salida', answer.validationPassed === true, answer.flags.join(', ') || 'sin hallazgos');
  return checks;
}

/** Comprobaciones blandas: miran el texto. Se reportan aparte y NO cuentan para el acierto. */
function softChecks(expect, answer) {
  const checks = [];
  for (const pattern of expect.answerMatches ?? []) {
    checks.push({ name: `texto ~ /${pattern}/`, pass: new RegExp(pattern, 'i').test(answer.answer) });
  }
  for (const pattern of expect.answerNotMatches ?? []) {
    checks.push({ name: `texto !~ /${pattern}/`, pass: !new RegExp(pattern, 'i').test(answer.answer) });
  }
  return checks;
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

// --- Ejecución ---------------------------------------------------------------

const tokens = {};
for (const [role, creds] of Object.entries(SEED)) tokens[role] = await login(creds.email, creds.password);

const capabilities = await (await fetch(`${AGENT}/api/v1/agent/capabilities`, { headers: { authorization: `Bearer ${tokens.admin}` } })).json();
const label = arg('label', capabilities.provider === 'mock' ? 'mock · determinista' : `vivo · ${capabilities.model}`);

process.stderr.write(`Evaluando ${GOLDEN_SET.length} casos · proveedor ${capabilities.provider} · modelo ${capabilities.model}\n`);

const results = [];
for (const [i, testCase] of GOLDEN_SET.entries()) {
  process.stderr.write(`  [${i + 1}/${GOLDEN_SET.length}] ${testCase.id} …`);
  const started = Date.now();
  const res = await ask(tokens[testCase.as], testCase.question);
  const wallMs = Date.now() - started;

  if (!res.ok) {
    results.push({ ...testCase, error: `${res.status} ${res.body.code ?? ''}`, wallMs, hard: [], soft: [] });
    process.stderr.write(` NO EJECUTADO (${res.status} ${res.body.code ?? ''})\n`);
  } else {
    const hard = hardChecks(testCase.expect, res.body);
    const soft = softChecks(testCase.expect, res.body);
    results.push({ ...testCase, answer: res.body, wallMs, hard, soft });
    process.stderr.write(` ${hard.every((c) => c.pass) ? 'OK' : 'FALLA'} (${res.body.mode}, ${res.body.latency.totalMs} ms)\n`);
  }
  if (i < GOLDEN_SET.length - 1) await sleep(PACE_MS);
}

// --- Métricas ----------------------------------------------------------------

const ok = results.filter((r) => r.answer);
const passed = ok.filter((r) => r.hard.every((c) => c.pass));
const softAll = ok.flatMap((r) => r.soft);
const latencies = ok.map((r) => r.answer.latency.totalMs);
const sum = (f) => ok.reduce((n, r) => n + f(r.answer), 0);
const modes = {};
const models = {};
for (const r of ok) {
  modes[r.answer.mode] = (modes[r.answer.mode] ?? 0) + 1;
  models[r.answer.model] = (models[r.answer.model] ?? 0) + 1;
}

const metrics = {
  casos: results.length,
  respondidos: ok.length,
  acierto: ok.length ? Math.round((passed.length / ok.length) * 1000) / 10 : 0,
  blandas: softAll.length ? Math.round((softAll.filter((c) => c.pass).length / softAll.length) * 1000) / 10 : null,
  p50: percentile(latencies, 50),
  p95: percentile(latencies, 95),
  min: Math.min(...latencies, 0),
  max: Math.max(...latencies, 0),
  tokens: {
    input: sum((a) => a.usage.input),
    output: sum((a) => a.usage.output),
    thinking: sum((a) => a.usage.thinking),
    embedding: sum((a) => a.usage.embedding),
  },
  costoUsd: Math.round(sum((a) => a.usage.costUsd) * 1e6) / 1e6,
  modes,
  models,
};

// --- Reporte -----------------------------------------------------------------

const fecha = new Date().toISOString().slice(0, 16).replace('T', ' ');
const porCategoria = {};
for (const r of ok) {
  const c = (porCategoria[r.category] ??= { total: 0, pass: 0 });
  c.total += 1;
  if (r.hard.every((x) => x.pass)) c.pass += 1;
}

const lines = [
  `# Evaluación del agente · ${label}`,
  '',
  `> Generado por \`npm run eval\` el ${fecha} UTC contra el stack real.`,
  `> Proveedor **${capabilities.provider}**, modelo configurado **${capabilities.model}**`,
  `> (respaldo \`${capabilities.fallbackModel}\`), prompt **${capabilities.promptVersion}**,`,
  `> ${capabilities.knowledgeChunks} pasajes indexados.`,
  '',
  '## Resumen',
  '',
  '| Métrica | Valor |',
  '|---|---:|',
  `| Casos | ${metrics.casos} |`,
  `| Respondidos | ${metrics.respondidos} |`,
  `| **Acierto** (comprobaciones duras) | **${metrics.acierto} %** |`,
  `| Indicios de calidad (comprobaciones blandas) | ${metrics.blandas === null ? '—' : `${metrics.blandas} %`} |`,
  `| Latencia p50 | ${metrics.p50} ms |`,
  `| Latencia p95 | ${metrics.p95} ms |`,
  `| Latencia mín. / máx. | ${metrics.min} / ${metrics.max} ms |`,
  `| Tokens (entrada / salida / razonamiento / embeddings) | ${metrics.tokens.input} / ${metrics.tokens.output} / ${metrics.tokens.thinking} / ${metrics.tokens.embedding} |`,
  `| **Costo estimado del golden set** | **$${metrics.costoUsd.toFixed(6)}** |`,
  `| Modo de respuesta | ${Object.entries(metrics.modes).map(([k, v]) => `${k}: ${v}`).join(' · ')} |`,
  `| Modelo que respondió | ${Object.entries(metrics.models).map(([k, v]) => `${k}: ${v}`).join(' · ')} |`,
  '',
  '## Por categoría',
  '',
  '| Categoría | Acierto |',
  '|---|---:|',
  ...Object.entries(porCategoria).map(([c, v]) => `| ${CATEGORIES[c] ?? c} | ${v.pass}/${v.total} |`),
  '',
  '## Caso por caso',
  '',
  '| # | Rol | Pregunta | Modo | ms | Comprobaciones |',
  '|---|---|---|---|---:|---|',
  ...results.map((r) => {
    if (!r.answer) return `| \`${r.id}\` | ${r.as} | ${r.question} | — | ${r.wallMs} | ⚠️ ${r.error} |`;
    const fails = r.hard.filter((c) => !c.pass);
    const estado = fails.length === 0 ? '✅' : `❌ ${fails.map((c) => `${c.name} (${c.detail})`).join('; ')}`;
    const soft = r.soft.filter((c) => !c.pass);
    const nota = soft.length ? ` · indicio no cumplido: ${soft.map((c) => c.name).join(', ')}` : '';
    return `| \`${r.id}\` | ${r.as} | ${r.question} | ${r.answer.mode} | ${r.answer.latency.totalMs} | ${estado}${nota} |`;
  }),
  '',
];

const out = arg('out', `docs/ai/reports/${capabilities.provider === 'mock' ? 'mock' : `live-${capabilities.model}`}.md`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));

process.stderr.write(`\nAcierto ${metrics.acierto} % · p50 ${metrics.p50} ms · p95 ${metrics.p95} ms · $${metrics.costoUsd.toFixed(6)}\n`);
process.stderr.write(`Reporte: ${out}\n`);
process.exit(passed.length === ok.length && ok.length === results.length ? 0 : 1);
