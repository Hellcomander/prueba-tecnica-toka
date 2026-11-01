import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { type FunctionDeclaration, type GenerateContentResponse, GoogleGenAI, type Part, ThinkingLevel } from '@google/genai';
import type { EmbeddingProvider, EmbeddingResult, EmbeddingTask, LlmProvider, LlmRequest, LlmResult, ToolRequest } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { ENV, type Env } from '../config/env';
import { describeProviderError, translateGeminiError } from './gemini-errors';

/**
 * Adaptador de Gemini. Lo que aquí se decide, y por qué:
 *
 *  - **Los reintentos del SDK se bajan a 1.** Reintentar por dentro multiplica el plazo real sin
 *    que el llamador se entere; la escalera de degradación (otro modelo, luego solo RAG) es una
 *    respuesta mejor que esperar el triple.
 *  - **Timeout explícito por llamada.** En el spike, una llamada sin plazo tardó 232 segundos.
 *    El SDK traduce el timeout del cliente a la cabecera `X-Server-Timeout`, así que es el
 *    servidor quien corta.
 *  - **`thinkingLevel: 'low'`**, porque Gemini 3 ignora `thinkingBudget: 0`. Los tokens de
 *    razonamiento se cobran y se reportan aparte, así que se devuelven en `usage.thinking` en
 *    vez de diluirlos en la salida.
 *  - **El 429 se traduce a un error de dominio con `retryAfterSeconds`** tomado de
 *    `RetryInfo.retryDelay`. Reintentar a ciegas contra un límite de cuota solo lo empeora.
 */
@Injectable()
export class GeminiLlmProvider implements LlmProvider {
  private readonly client: GoogleGenAI;
  readonly primaryModel: string;
  readonly fallbackModel: string;

  constructor(
    @Inject(ENV) env: Env,
    @InjectPinoLogger(GeminiLlmProvider.name) private readonly logger: PinoLogger,
  ) {
    this.client = new GoogleGenAI({
      apiKey: env.GEMINI_API_KEY,
      httpOptions: { timeout: env.AI_LLM_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });
    this.primaryModel = env.GEMINI_MODEL;
    this.fallbackModel = env.GEMINI_FALLBACK_MODEL;
  }

  async generate(request: LlmRequest, model: string): Promise<LlmResult> {
    const contents = request.messages.map((message) => {
      const parts: Part[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolRequests ?? []) {
        // La firma vuelve en la misma parte de la que salió: Gemini 3 responde 400 si falta.
        parts.push({ functionCall: { id: call.id, name: call.name, args: call.args }, ...(call.signature ? { thoughtSignature: call.signature } : {}) });
      }
      for (const response of message.toolResponses ?? []) {
        parts.push({ functionResponse: { id: response.id, name: response.name, response: asRecord(response.result) } });
      }
      return { role: message.role === 'model' ? 'model' : 'user', parts };
    });

    try {
      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: request.systemPrompt,
          maxOutputTokens: request.maxOutputTokens,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          ...(request.tools.length > 0
            ? { tools: [{ functionDeclarations: request.tools.map(toDeclaration) }] }
            : {}),
        },
      });
      return this.toResult(response, model);
    } catch (error) {
      this.logger.warn({ event: 'gemini.error', model, ...describeProviderError(error) }, 'gemini.error');
      throw translateGeminiError(error, model);
    }
  }

  private toResult(response: GenerateContentResponse, model: string): LlmResult {
    const usage = response.usageMetadata;
    // `response.functionCalls` aplana las llamadas y pierde la firma, que vive en la parte: hay
    // que emparejarlas recorriendo las partes del candidato en orden.
    const signatures = (response.candidates?.[0]?.content?.parts ?? []).filter((part) => part.functionCall).map((part) => part.thoughtSignature);
    const toolRequests: ToolRequest[] = (response.functionCalls ?? []).map((call, i) => ({
      id: call.id ?? `call-${i}`,
      name: call.name ?? '',
      args: (call.args ?? {}) as Record<string, unknown>,
      ...(signatures[i] ? { signature: signatures[i] } : {}),
    }));
    return {
      text: response.text ?? '',
      toolRequests: toolRequests.filter((call) => call.name.length > 0),
      usage: {
        input: usage?.promptTokenCount ?? 0,
        output: usage?.candidatesTokenCount ?? 0,
        thinking: usage?.thoughtsTokenCount ?? 0,
      },
      model,
      finishReason: response.candidates?.[0]?.finishReason ?? null,
    };
  }

}

/**
 * Embeddings con Gemini. `taskType` importa: un embedding de consulta y uno de documento se
 * generan de forma distinta y mezclarlos degrada la recuperación de forma silenciosa.
 */
@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly client: GoogleGenAI;
  readonly model: string;
  readonly dimensions: number;
  readonly minScore: number;

  constructor(@Inject(ENV) env: Env) {
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: env.AI_LLM_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    this.model = env.GEMINI_EMBEDDING_MODEL;
    this.dimensions = env.GEMINI_EMBEDDING_DIM;
    this.minScore = env.AI_RETRIEVAL_MIN_SCORE;
  }

  async embed(texts: string[], task: EmbeddingTask): Promise<EmbeddingResult> {
    const response = await this.client.models.embedContent({
      model: this.model,
      contents: texts,
      config: { taskType: task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: this.dimensions },
    });
    const vectors = (response.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length) {
      throw new DomainError('AI_EMBEDDING_FAILED', 'unavailable', 'El proveedor devolvió menos embeddings de los pedidos.');
    }
    return { vectors: vectors.map(normalize), tokens: response.metadata?.billableCharacterCount ?? estimateTokens(texts) };
  }
}

function toDeclaration(tool: { name: string; description: string; parameters: Record<string, unknown> }): FunctionDeclaration {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
}

/** `gemini-embedding-001` no entrega vectores normalizados por debajo de 3072 dimensiones. */
function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return magnitude > 0 ? vector.map((v) => v / magnitude) : vector;
}

const estimateTokens = (texts: string[]): number => Math.ceil(texts.join(' ').length / 4);
