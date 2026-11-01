import { useEffect, useRef, useState } from 'react';
import { API_MODE } from '@/config';
import { DemoModeNotice, EmptyState } from '@/components/empty-state';
import type { AgentAnswer, AnswerMode, Citation, ToolCallRecord } from '@/services/agent-api';
import { useAgentStore, type Turn } from '@/state/agent-store';

const MODE_LABELS: Record<AnswerMode, { label: string; title: string; tone: string }> = {
  normal: { label: 'MODELO PRINCIPAL', title: 'Respondió el modelo principal.', tone: 'ok' },
  fallback_model: { label: 'MODELO DE RESPALDO', title: 'El modelo principal no respondió a tiempo; contestó el de respaldo.', tone: 'warn' },
  rag_only: { label: 'SOLO BASE DE CONOCIMIENTO', title: 'Ningún modelo respondió: esto son los pasajes recuperados, sin redactar.', tone: 'warn' },
  cached: { label: 'EN CACHÉ', title: 'Respuesta idéntica servida desde la caché: no se llamó al modelo.', tone: 'ok' },
};

const SUGGESTIONS = [
  '¿Quién puede suspender a un usuario?',
  '¿Cuántos usuarios activos hay?',
  '¿Qué roles existen y qué permisos tiene cada uno?',
  '¿Qué pasa con la sesión de alguien a quien suspendo?',
];

const ms = (value: number) => `${Math.round(value)} ms`;

/**
 * Los pasajes son markdown porque la base de conocimiento son archivos .md del repositorio. En
 * un extracto corto, `**negrita**` y las comillas invertidas estorban más de lo que aportan, así
 * que se quitan las marcas y se deja el texto. No se interpreta el markdown: el extracto es una
 * muestra para decidir si abrir la fuente, no el documento.
 */
const plain = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    // El extracto se corta a 300 caracteres y el corte puede partir un par de marcas por la
    // mitad: lo que quede suelto se quita en vez de enseñar un `**` colgando.
    .replace(/[*`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** El encabezado de la sección viaja dentro del texto embebido y ya se muestra en la cabecera. */
function excerptOf(citation: Citation): string {
  const text = plain(citation.excerpt);
  return text.startsWith(citation.section) ? text.slice(citation.section.length).trim() : text;
}

/** El costo por pregunta es de centésimas de centavo: con dos decimales siempre se vería "0.00". */
const usd = (value: number) => (value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(6)}`);

export function AssistantPage() {
  const isReal = API_MODE === 'real';
  const turns = useAgentStore((state) => state.turns);
  const pending = useAgentStore((state) => state.pending);
  const capabilities = useAgentStore((state) => state.capabilities);
  const ask = useAgentStore((state) => state.ask);
  const loadCapabilities = useAgentStore((state) => state.loadCapabilities);
  const reset = useAgentStore((state) => state.reset);

  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isReal) void loadCapabilities();
  }, [isReal, loadCapabilities]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const submit = (question: string) => {
    const text = question.trim();
    if (!text || pending) return;
    setDraft('');
    void ask(text);
  };

  return (
    <div className="assistant-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">ASISTENTE</p>
          <h1>Asistente IA</h1>
          <p className="muted">
            Responde sobre las políticas internas citando la base de conocimiento, y consulta datos en vivo con tus
            propios permisos. Solo lee: no puede crear, modificar ni suspender nada.
          </p>
        </div>
        {turns.length > 0 && (
          <button type="button" className="button button-ghost" onClick={reset}>
            Nueva conversación
          </button>
        )}
      </header>

      {!isReal ? (
        <div className="panel panel-padded">
          <DemoModeNotice section="El asistente" />
        </div>
      ) : (
        <>
          {capabilities && <CapabilitiesBar capabilities={capabilities} />}

          <section className="panel assistant-thread" aria-label="Conversación" aria-busy={pending}>
            {turns.length === 0 ? (
              <div className="assistant-intro">
                <EmptyState
                  symbol="✦"
                  title="Pregunta lo que necesites."
                  description="Cada afirmación que venga de la base de conocimiento se cita, y cada dato en vivo dice con qué herramienta se obtuvo."
                />
                <div className="suggestion-row">
                  {SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" className="suggestion" onClick={() => submit(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ol className="turn-list">
                {turns.map((turn) => (
                  <TurnItem key={turn.id} turn={turn} />
                ))}
              </ol>
            )}
            <div ref={endRef} />
          </section>

          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit(draft);
            }}
          >
            <label className="sr-only" htmlFor="assistant-question">
              Tu pregunta
            </label>
            <textarea
              id="assistant-question"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter envía, Mayús+Enter hace salto de línea: es lo que espera quien escribe
                // en un chat, y escribir párrafos aquí es la excepción.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit(draft);
                }
              }}
              placeholder="¿Quién puede suspender a un usuario?"
              rows={2}
              maxLength={1000}
              disabled={pending}
            />
            <div className="composer-actions">
              <span className="muted">{draft.length}/1000</span>
              <button type="submit" className="button button-primary" disabled={pending || draft.trim().length < 3}>
                {pending ? 'Pensando…' : 'Preguntar'}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Decir en qué modo está no es un detalle de depuración: si alguien ve respuestas creíbles sin
 * saber que vienen del proveedor mock, se lleva una impresión falsa del sistema.
 */
function CapabilitiesBar({ capabilities }: { capabilities: NonNullable<ReturnType<typeof useAgentStore.getState>['capabilities']> }) {
  const isMock = capabilities.provider === 'mock';
  return (
    <section className={`capabilities-bar ${isMock ? 'is-mock' : ''}`} aria-label="Configuración del asistente">
      <div>
        <span>PROVEEDOR</span>
        <strong>{isMock ? 'Mock determinista' : 'Gemini'}</strong>
        {isMock && <small>Sin GEMINI_API_KEY: las respuestas son sintéticas y reproducibles.</small>}
      </div>
      <div>
        <span>MODELO</span>
        <strong>{capabilities.model}</strong>
        <small>respaldo: {capabilities.fallbackModel}</small>
      </div>
      <div>
        <span>BASE DE CONOCIMIENTO</span>
        <strong>{capabilities.knowledgeChunks} pasajes</strong>
        <small>{capabilities.embeddingModel}</small>
      </div>
      <div>
        <span>HERRAMIENTAS</span>
        <strong>{capabilities.tools.length} disponibles</strong>
        <small title={capabilities.tools.map((tool) => `${tool.name} · ${tool.requiredPermission}`).join('\n')}>
          según tus permisos
        </small>
      </div>
    </section>
  );
}

function TurnItem({ turn }: { turn: Turn }) {
  return (
    <li className="turn">
      <p className="turn-question">{turn.question}</p>
      {turn.answer ? <AnswerBlock answer={turn.answer} /> : turn.error ? <ErrorBlock error={turn.error} /> : <PendingBlock />}
    </li>
  );
}

function PendingBlock() {
  return (
    <div className="turn-answer is-pending" role="status">
      <span className="dot-pulse" aria-hidden="true" />
      Consultando la base de conocimiento y el modelo…
    </div>
  );
}

function ErrorBlock({ error }: { error: NonNullable<Turn['error']> }) {
  const countdown = useCountdown(error.retryAfterSeconds);
  return (
    <div className="turn-answer is-error" role="alert">
      <p>{error.message}</p>
      {countdown !== null && (
        <p className="muted">{countdown > 0 ? `Puedes volver a preguntar en ${countdown} s.` : 'Ya puedes volver a preguntar.'}</p>
      )}
      {error.code && <code className="error-code">{error.code}</code>}
    </div>
  );
}

function AnswerBlock({ answer }: { answer: AgentAnswer }) {
  const mode = MODE_LABELS[answer.mode];
  return (
    <div className="turn-answer">
      <div className="answer-head">
        <span className={`mode-badge mode-${mode.tone}`} title={mode.title}>
          {mode.label}
        </span>
        {!answer.validationPassed && (
          <span className="mode-badge mode-warn" title="El validador de salida encontró algo: revisa las señales.">
            VALIDACIÓN CON HALLAZGOS
          </span>
        )}
        {answer.toolCalls.map((call, i) => (
          <ToolChip key={`${call.name}-${i}`} call={call} />
        ))}
      </div>

      <p className="answer-text">{answer.answer}</p>

      {answer.citations.length > 0 && (
        <details className="citations" open>
          <summary>{answer.citations.length} pasaje(s) citado(s)</summary>
          <ol className="citation-list">
            {answer.citations.map((citation) => (
              <CitationItem key={citation.index} citation={citation} />
            ))}
          </ol>
        </details>
      )}

      {answer.flags.length > 0 && (
        <ul className="flag-list" aria-label="Señales">
          {answer.flags.map((flag) => (
            <li key={flag} className={flag.startsWith('injection:') ? 'flag flag-alert' : 'flag'}>
              {describeFlag(flag)}
            </li>
          ))}
        </ul>
      )}

      {/*
        Los tramos van separados a propósito: "la IA está lenta" no es accionable, pero
        "recuperación 40 ms, modelo 11 s, herramientas 66 ms" dice exactamente dónde mirar.
      */}
      <dl className="answer-metrics">
        <div>
          <dt>TOTAL</dt>
          <dd>{ms(answer.latency.totalMs)}</dd>
        </div>
        <div>
          <dt>RECUPERACIÓN</dt>
          <dd>{ms(answer.latency.retrievalMs)}</dd>
        </div>
        <div>
          <dt>MODELO</dt>
          <dd>{ms(answer.latency.llmMs)}</dd>
        </div>
        <div>
          <dt>HERRAMIENTAS</dt>
          <dd>{ms(answer.latency.toolsMs)}</dd>
        </div>
        <div>
          <dt>TOKENS</dt>
          <dd title={`entrada ${answer.usage.input} · salida ${answer.usage.output} · razonamiento ${answer.usage.thinking} · embeddings ${answer.usage.embedding}`}>
            {answer.usage.input + answer.usage.output + answer.usage.thinking + answer.usage.embedding}
          </dd>
        </div>
        <div>
          <dt>COSTO EST.</dt>
          <dd>{usd(answer.usage.costUsd)}</dd>
        </div>
      </dl>
    </div>
  );
}

function ToolChip({ call }: { call: ToolCallRecord }) {
  const detail = Object.entries(call.args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
  return (
    <span
      className={`tool-chip ${call.ok ? '' : 'tool-chip-failed'}`}
      title={`${call.ok ? 'Consulta correcta' : `Falló: ${call.error ?? 'sin detalle'}`}${detail ? `\n${detail}` : ''}\n${ms(call.durationMs)}`}
    >
      {call.ok ? '⚙' : '⚠'} {call.name}
    </span>
  );
}

function CitationItem({ citation }: { citation: Citation }) {
  return (
    <li>
      <div className="citation-head">
        <strong>[KB-{citation.index}]</strong>
        <span>
          {citation.title} › {citation.section}
        </span>
        <code title="Similitud con la pregunta">{citation.score.toFixed(3)}</code>
      </div>
      <p>{excerptOf(citation)}</p>
    </li>
  );
}

const FLAG_LABELS: Record<string, string> = {
  'degraded:fallback_model': 'El modelo principal no respondió; contestó el de respaldo.',
  'degraded:rag_only': 'Ningún modelo respondió: se muestran los pasajes recuperados.',
  'validation:canary_leak': 'La respuesta intentaba revelar las instrucciones internas y se descartó.',
  'validation:invalid_citation': 'Se eliminó una cita que no apuntaba a ningún pasaje recuperado.',
  'validation:secret_redacted': 'Se redactó algo que parecía un secreto.',
  'validation:no_citations': 'La respuesta no citó ningún pasaje.',
};

function describeFlag(flag: string): string {
  if (FLAG_LABELS[flag]) return FLAG_LABELS[flag];
  if (flag.startsWith('injection:question:')) return 'La pregunta contiene un patrón de inyección de instrucciones.';
  if (flag.startsWith('injection:context:')) return 'Un documento recuperado contiene texto que parece una instrucción.';
  return flag;
}

/** Cuenta regresiva para el `Retry-After`: se detiene en cero y no reintenta sola. */
function useCountdown(seconds: number | null): number | null {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
    if (seconds === null) return;
    const timer = setInterval(() => setRemaining((value) => (value === null || value <= 0 ? 0 : value - 1)), 1_000);
    return () => clearInterval(timer);
  }, [seconds]);

  return remaining;
}
