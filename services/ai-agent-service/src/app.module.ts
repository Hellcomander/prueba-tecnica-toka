import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AuthModule, CommonModule, HealthModule, MessagingModule } from '@toka/nest-common';
import { AskQuestionUseCase } from './application/commands/ask-question.use-case';
import { IngestKnowledgeBaseUseCase } from './application/commands/ingest-knowledge-base.use-case';
import { AGENT_EVENT_SINK, AGENT_OPTIONS, type AgentOptions, CLOCK } from './application/ports';
import { EMBEDDING_PROVIDER, LLM_PROVIDER, RATE_LIMITER, ANSWER_CACHE, KNOWLEDGE_SOURCE, TOOL_GATEWAY, VECTOR_STORE } from './domain/ports';
import { ENV, type Env, resolveProvider } from './infrastructure/config/env';
import { FileKnowledgeSource } from './infrastructure/knowledge/file-knowledge-source';
import { IngestBootstrap } from './infrastructure/knowledge/ingest-bootstrap';
import { GeminiEmbeddingProvider, GeminiLlmProvider } from './infrastructure/llm/gemini-provider';
import { MockEmbeddingProvider, MockLlmProvider } from './infrastructure/llm/mock-provider';
import { AmqpAgentEventSink } from './infrastructure/messaging/amqp-agent-events';
import { RedisAnswerCache } from './infrastructure/redis/answer-cache';
import { RedisRateLimiter } from './infrastructure/redis/rate-limiter';
import { RedisService } from './infrastructure/redis/redis.service';
import { HttpToolGateway } from './infrastructure/tools/http-tool-gateway';
import { QdrantVectorStore } from './infrastructure/vector/qdrant-store';
import { AgentController } from './interface/http/agent.controller';

@Global()
@Module({})
class InfraModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: ENV, useValue: env }, RedisService],
      exports: [ENV, RedisService],
    };
  }
}

/**
 * Composition root: aquí, y solo aquí, se decide qué adaptador implementa cada puerto.
 *
 * La elección de proveedor es una línea (`resolveProvider`) y es lo que hace que el stack corra
 * sin API key: sin `GEMINI_API_KEY`, el mock ocupa el mismo hueco y todo lo demás —recuperación,
 * ACL, bucle de tools, validador, límites, interfaz— funciona igual.
 */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    const useGemini = resolveProvider(env) === 'gemini';
    const options: AgentOptions = {
      promptVersion: env.AI_PROMPT_VERSION,
      canary: env.AI_CANARY,
      maxToolSteps: env.AI_MAX_TOOL_STEPS,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      retrievalLimit: env.AI_RETRIEVAL_LIMIT,
      cacheTtlSeconds: env.AI_CACHE_TTL_SECONDS,
      pricing: {
        inputPerMillion: env.AI_PRICE_INPUT_PER_MTOK,
        outputPerMillion: env.AI_PRICE_OUTPUT_PER_MTOK,
        embeddingPerMillion: env.AI_PRICE_EMBEDDING_PER_MTOK,
      },
    };

    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(env),
        CommonModule.forRoot({ service: 'ai-agent-service', level: env.LOG_LEVEL }),
        AuthModule.forRoot({ issuer: env.OIDC_ISSUER, jwksUri: env.JWKS_URI, audience: env.AUTH_AUDIENCE, securityEvents: 'publish' }),
        MessagingModule.forRoot({ url: env.RABBITMQ_URL }),
        // `ready` mira Redis, no Qdrant ni Gemini: el asistente degrada a solo-RAG o a 503 por
        // petición, y sacarlo de rotación entero por un vecino caído sería encadenar fallos.
        HealthModule.forRoot({
          inject: [RedisService],
          useFactory: (redis: RedisService) => [{ name: 'redis', check: () => redis.ping() }],
        }),
      ],
      controllers: [AgentController],
      providers: [
        { provide: AGENT_OPTIONS, useValue: options },
        { provide: CLOCK, useValue: { now: () => Date.now() } },
        { provide: LLM_PROVIDER, useClass: useGemini ? GeminiLlmProvider : MockLlmProvider },
        {
          provide: EMBEDDING_PROVIDER,
          ...(useGemini
            ? { useClass: GeminiEmbeddingProvider }
            : { useFactory: (e: Env) => new MockEmbeddingProvider(e.GEMINI_EMBEDDING_DIM), inject: [ENV] }),
        },
        { provide: VECTOR_STORE, useClass: QdrantVectorStore },
        { provide: TOOL_GATEWAY, useClass: HttpToolGateway },
        { provide: RATE_LIMITER, useClass: RedisRateLimiter },
        { provide: ANSWER_CACHE, useClass: RedisAnswerCache },
        { provide: KNOWLEDGE_SOURCE, useClass: FileKnowledgeSource },
        { provide: AGENT_EVENT_SINK, useClass: AmqpAgentEventSink },
        AskQuestionUseCase,
        IngestKnowledgeBaseUseCase,
        IngestBootstrap,
      ],
    };
  }
}
