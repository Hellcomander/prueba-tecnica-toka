import { Inject, Injectable } from '@nestjs/common';
import type { AgentAnswer, AnswerMode, Citation, ToolCallRecord } from '../../domain/answer/answer';
import { addUsage, EMPTY_USAGE, estimateCostUsd, type TokenUsage, totalTokens } from '../../domain/answer/usage';
import { detectInjection } from '../../domain/guardrails/injection';
import { validateOutput } from '../../domain/guardrails/output-validator';
import {
  ANSWER_CACHE,
  type AnswerCache,
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  RATE_LIMITER,
  type RateLimiter,
  type SearchHit,
  TOOL_GATEWAY,
  type ToolGateway,
  type ToolRequest,
  type ToolResponse,
  VECTOR_STORE,
  type VectorStore,
} from '../../domain/ports';
import { Question } from '../../domain/question';
import { DomainError } from '../../domain/shared/domain-error';
import { AGENT_EVENT_SINK, AGENT_OPTIONS, type AgentEventSink, type AgentOptions, CLOCK, type Clock } from '../ports';
import { systemPrompt, userTurn } from '../prompts/agent-prompt';
import { TOOLS_BY_NAME, toolsFor } from '../tools/catalog';

export interface AskQuestionInput {
  question: string;
  /** Si es false, se ignora una respuesta en caché (lo usa el runner de evaluación). */
  useCache?: boolean;
}

export interface Asker {
  userId: string;
  permissions: readonly string[];
  /** Se reenvía a cada herramienta para que el servicio destino vuelva a autorizar. */
  accessToken: string;
}

/** Peldaños de la escalera de degradación, en orden. */
interface Rung {
  model: string;
  mode: Extract<AnswerMode, 'normal' | 'fallback_model'>;
}

@Injectable()
export class AskQuestionUseCase {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(TOOL_GATEWAY) private readonly tools: ToolGateway,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ANSWER_CACHE) private readonly cache: AnswerCache,
    @Inject(AGENT_EVENT_SINK) private readonly events: AgentEventSink,
    @Inject(AGENT_OPTIONS) private readonly options: AgentOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: AskQuestionInput, asker: Asker): Promise<AgentAnswer> {
    const started = this.clock.now();
    const question = Question.of(input.question);
    const flags: string[] = [];

    // 1. Límites propios, antes de gastar nada. Van primero porque el objetivo es proteger la
    //    cuota: comprobar después de embeber ya habría costado una llamada.
    const decision = await this.limiter.check(asker.userId);
    if (!decision.allowed) {
      throw new DomainError(
        'AI_RATE_LIMITED',
        'unprocessable',
        decision.scope?.startsWith('user')
          ? 'Alcanzaste tu límite de consultas al asistente. Intenta de nuevo en un momento.'
          : 'El asistente alcanzó su límite global de consultas. Intenta de nuevo en un momento.',
        decision.retryAfterSeconds,
      );
    }

    // 2. Caché. La clave incluye los permisos porque dos usuarios con permisos distintos ven
    //    pasajes distintos: compartir respuesta entre ellos sería una fuga de autorización.
    const cacheKey = this.cacheKey(question.hash(), asker.permissions);
    if (input.useCache !== false) {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        const cached = JSON.parse(hit) as AgentAnswer;
        // Los tramos y el gasto se ponen a cero porque **esta** petición no gastó nada: no hubo
        // recuperación, ni modelo, ni herramientas, y por eso tampoco se registra uso ni se
        // publica evento. Devolver los números de la petición original junto a un total de 6 ms
        // produce un panel que se contradice a sí mismo ("total 6 ms, modelo 2321 ms") y, peor,
        // contaría dos veces un costo que solo se pagó una.
        return {
          ...cached,
          mode: 'cached',
          latency: { totalMs: this.clock.now() - started, retrievalMs: 0, llmMs: 0, toolsMs: 0 },
          usage: { input: 0, output: 0, thinking: 0, embedding: 0, costUsd: 0 },
        };
      }
    }

    // 3. Recuperación con ACL aplicado en la consulta al store.
    const retrievalStart = this.clock.now();
    const embedded = await this.embeddings.embed([question.text], 'query');
    let usage: TokenUsage = addUsage(EMPTY_USAGE, { embedding: embedded.tokens });
    const hits = await this.store.search(embedded.vectors[0], {
      limit: this.options.retrievalLimit,
      permissions: asker.permissions,
      minScore: this.options.retrievalMinScore,
    });
    const retrievalMs = this.clock.now() - retrievalStart;

    // 4. Guardrail de entrada: se revisan la pregunta y los pasajes recuperados. No bloquea; marca.
    const signals = detectInjection({ question: question.text, passages: hits.map((h) => h.chunk.text) });
    for (const signal of signals) flags.push(`injection:${signal.target}:${signal.rule}`);

    // 5. Escalera: modelo primario → modelo de respaldo → solo RAG → 503.
    const available = toolsFor(asker.permissions);
    const messages: LlmMessage[] = [{ role: 'user', text: userTurn(question.text, hits) }];
    // Cada peldaño lleva su propia lista: si el primario falla a mitad del bucle y responde el de
    // respaldo, la interfaz debe ver las herramientas que produjeron la respuesta que se devuelve,
    // no la suma de dos intentos. Si no responde ninguno se reporta el último intento.
    let toolCalls: ToolCallRecord[] = [];
    const timings = { llmMs: 0, toolsMs: 0 };
    const rungs: Rung[] = [
      { model: this.llm.primaryModel, mode: 'normal' },
      ...(this.llm.fallbackModel && this.llm.fallbackModel !== this.llm.primaryModel
        ? [{ model: this.llm.fallbackModel, mode: 'fallback_model' as const }]
        : []),
    ];

    let answer: { text: string; mode: AnswerMode; model: string } | null = null;
    let lastError: unknown = null;
    for (const rung of rungs) {
      const attemptCalls: ToolCallRecord[] = [];
      try {
        const loop = await this.runToolLoop({ messages: [...messages], rung, available, asker, toolCalls: attemptCalls, timings, usage });
        usage = loop.usage;
        toolCalls = attemptCalls;
        answer = { text: loop.text, mode: rung.mode, model: loop.model };
        // El motivo viaja con la señal. "Bajé al modelo de respaldo" no es accionable; "el
        // primario agotó su cuota diaria" sí, y es una respuesta distinta de "tardó demasiado":
        // una se arregla esperando minutos y la otra esperando horas o cambiando de modelo.
        if (rung.mode === 'fallback_model') flags.push(`degraded:fallback_model:${reasonOf(lastError)}`);
        break;
      } catch (error) {
        // Se guarda el último fallo y se baja un peldaño. El adaptador ya registró el detalle
        // del proveedor; aquí solo importa que este peldaño no sirvió.
        lastError = error;
        toolCalls = attemptCalls;
      }
    }

    let validationPassed: boolean;
    let citations: Citation[];
    let text: string;

    if (answer) {
      const validation = validateOutput({
        text: answer.text,
        passageCount: hits.length,
        canary: this.options.canary,
        // Solo se exige citar cuando la respuesta no vino de una herramienta: un dato en vivo
        // (cuántos usuarios activos hay) no está en la base de conocimiento y no se puede citar.
        expectCitations: hits.length > 0 && toolCalls.length === 0,
      });
      validationPassed = validation.passed;
      for (const issue of validation.issues) flags.push(`validation:${issue}`);
      text = validation.text;
      citations = validation.citedIndexes.map((index) => toCitation(hits[index - 1], index));
    } else if (hits.length > 0) {
      // Peldaño 3: sin modelo, pero con pasajes. Se devuelve lo recuperado, citado y marcado
      // como tal. Es peor que una respuesta redactada, pero es verdadero y verificable.
      answer = { text: '', mode: 'rag_only', model: 'none' };
      citations = hits.slice(0, 3).map((hit, i) => toCitation(hit, i + 1));
      text = ragOnlyAnswer(citations);
      flags.push(`degraded:rag_only:${reasonOf(lastError)}`);
      validationPassed = false;
    } else {
      // Sin modelo y sin pasajes no hay nada honesto que decir.
      throw new DomainError(
        'AI_UNAVAILABLE',
        'unavailable',
        'El asistente no está disponible en este momento y no encontré nada en la base de conocimiento para responder.',
        30,
      );
    }
    void lastError;

    const totalMs = this.clock.now() - started;
    const costUsd = estimateCostUsd(usage, this.options.pricing);
    const result: AgentAnswer = {
      answer: text,
      citations,
      toolCalls,
      usage: { ...usage, costUsd },
      latency: { totalMs, retrievalMs, llmMs: timings.llmMs, toolsMs: timings.toolsMs },
      mode: answer.mode,
      model: answer.model,
      flags,
      validationPassed,
    };

    await this.limiter.recordUsage(asker.userId, totalTokens(usage));
    // Solo se cachea lo que salió bien: guardar una degradación la congelaría durante todo el TTL.
    if (result.mode === 'normal' && validationPassed) {
      await this.cache.set(cacheKey, JSON.stringify(result), this.options.cacheTtlSeconds);
    }
    await this.events.queryCompleted({
      userId: asker.userId,
      questionHash: question.hash(),
      toolsUsed: toolCalls.map((c) => c.name),
      latencyMs: totalMs,
      inputTokens: usage.input,
      outputTokens: usage.output,
      thinkingTokens: usage.thinking,
      embeddingTokens: usage.embedding,
      estimatedCostUsd: costUsd,
      model: result.model,
      mode: result.mode === 'cached' ? 'normal' : result.mode,
      cacheHit: false,
      validationPassed,
      flags,
    });

    return result;
  }

  /**
   * Bucle de herramientas, acotado a `maxToolSteps`. El tope no es decorativo: sin él, un modelo
   * que insiste en pedir la misma herramienta convierte una pregunta en una factura abierta y en
   * una petición HTTP que nunca termina. Al agotarse los pasos se responde con lo último que
   * dijo el modelo, no con un error: casi siempre ya tiene los datos para contestar.
   */
  private async runToolLoop(ctx: {
    messages: LlmMessage[];
    rung: Rung;
    available: ReturnType<typeof toolsFor>;
    asker: Asker;
    toolCalls: ToolCallRecord[];
    timings: { llmMs: number; toolsMs: number };
    usage: TokenUsage;
  }): Promise<{ text: string; model: string; usage: TokenUsage }> {
    let usage = ctx.usage;
    let last: LlmResult | null = null;

    for (let step = 0; step < this.options.maxToolSteps; step++) {
      const llmStart = this.clock.now();
      let result: LlmResult;
      try {
        result = await this.llm.generate(
          {
            systemPrompt: systemPrompt(this.options.promptVersion, this.options.canary),
            messages: ctx.messages,
            tools: ctx.available.map((t) => t.schema),
            maxOutputTokens: this.options.maxOutputTokens,
          },
          ctx.rung.model,
        );
      } finally {
        // El tiempo se suma también cuando la llamada falla: un intento que agotó su plazo de
        // 15 s es tiempo que el usuario esperó de verdad. Contarlo solo en el camino feliz
        // produce justo el panel inútil que describe el ejercicio 4: un total de 17 s con 2 s
        // atribuidos al modelo y 15 s sin dueño.
        ctx.timings.llmMs += this.clock.now() - llmStart;
      }
      usage = addUsage(usage, result.usage);
      last = result;

      if (result.toolRequests.length === 0) {
        return { text: result.text, model: result.model, usage };
      }

      // El turno del modelo se reenvía intacto: si se reconstruye, se pierde la correspondencia
      // entre la petición de herramienta y su respuesta, y el modelo se confunde de llamada.
      ctx.messages.push({ role: 'model', text: result.text, toolRequests: result.toolRequests });
      const responses: ToolResponse[] = [];
      for (const request of result.toolRequests) {
        responses.push(await this.invokeTool(request, ctx));
      }
      ctx.messages.push({ role: 'tool', toolResponses: responses });
    }

    return { text: last?.text ?? '', model: last?.model ?? ctx.rung.model, usage };
  }

  private async invokeTool(
    request: ToolRequest,
    ctx: { available: ReturnType<typeof toolsFor>; asker: Asker; toolCalls: ToolCallRecord[]; timings: { toolsMs: number } },
  ): Promise<ToolResponse> {
    const started = this.clock.now();
    const definition = TOOLS_BY_NAME.get(request.name);
    const allowed = definition !== undefined && ctx.available.some((t) => t.schema.name === request.name);

    // Segundo candado: aunque al modelo solo se le declararon las herramientas permitidas, se
    // vuelve a comprobar antes de invocar. El tercero es el propio servicio destino, que
    // revalida el JWT reenviado.
    if (!allowed) {
      ctx.toolCalls.push({ name: request.name, args: request.args, ok: false, durationMs: 0, error: 'not_allowed' });
      ctx.timings.toolsMs += this.clock.now() - started;
      return { id: request.id, name: request.name, result: { error: 'No tienes permiso para usar esta herramienta.' } };
    }

    try {
      const result = await this.tools.invoke({ name: request.name, args: request.args, accessToken: ctx.asker.accessToken });
      ctx.toolCalls.push({ name: request.name, args: request.args, ok: true, durationMs: this.clock.now() - started });
      ctx.timings.toolsMs += this.clock.now() - started;
      return { id: request.id, name: request.name, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error desconocido';
      ctx.toolCalls.push({ name: request.name, args: request.args, ok: false, durationMs: this.clock.now() - started, error: message });
      ctx.timings.toolsMs += this.clock.now() - started;
      // El fallo se le devuelve al modelo como resultado, no como excepción: así puede decir que
      // no pudo consultarlo en vez de que la petición entera se caiga.
      return { id: request.id, name: request.name, result: { error: `No se pudo consultar: ${message}` } };
    }
  }

  private cacheKey(questionHash: string, permissions: readonly string[]): string {
    return `agent:answer:${this.options.promptVersion}:${[...permissions].sort().join(',')}:${questionHash}`;
  }
}

/**
 * Traduce el fallo del peldaño anterior a un motivo corto y estable. Se queda en vocabulario
 * propio (`rate_limited`, `timeout`, `model_unavailable`) y no filtra el mensaje del proveedor,
 * que puede traer URLs, identificadores de proyecto y detalles de facturación.
 */
function reasonOf(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'AI_PROVIDER_RATE_LIMITED':
      return 'rate_limited';
    case 'AI_PROVIDER_TIMEOUT':
      return 'timeout';
    case 'AI_MODEL_NOT_AVAILABLE':
      return 'model_unavailable';
    default:
      return 'provider_error';
  }
}

function toCitation(hit: SearchHit, index: number): Citation {
  return {
    index,
    docId: hit.chunk.docId,
    title: hit.chunk.title,
    section: hit.chunk.section,
    score: Math.round(hit.score * 1_000) / 1_000,
    excerpt: hit.chunk.text.slice(0, 300),
  };
}

function ragOnlyAnswer(citations: Citation[]): string {
  const list = citations.map((c) => `- ${c.title} › ${c.section} [KB-${c.index}]`).join('\n');
  return `El modelo de lenguaje no está disponible, así que no puedo redactar una respuesta. Esto es lo más relevante que encontré en la base de conocimiento:\n\n${list}\n\nAbre los pasajes citados para ver el texto completo.`;
}
