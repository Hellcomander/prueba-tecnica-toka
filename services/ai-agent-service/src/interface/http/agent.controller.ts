import { Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser, RequirePermissions } from '@toka/nest-common';
import { AskQuestionUseCase } from '../../application/commands/ask-question.use-case';
import { IngestKnowledgeBaseUseCase, type IngestResult } from '../../application/commands/ingest-knowledge-base.use-case';
import { AGENT_OPTIONS, type AgentOptions } from '../../application/ports';
import { toolsFor } from '../../application/tools/catalog';
import type { AgentAnswer } from '../../domain/answer/answer';
import { EMBEDDING_PROVIDER, type EmbeddingProvider, LLM_PROVIDER, type LlmProvider, VECTOR_STORE, type VectorStore } from '../../domain/ports';
import { AskQuestionDto } from './dto/agent.dto';

export interface AgentCapabilities {
  /** `gemini` o `mock`: la interfaz lo muestra para que nadie confunda una demo con el modelo real. */
  provider: string;
  model: string;
  fallbackModel: string;
  embeddingModel: string;
  promptVersion: string;
  /** Solo las herramientas que este usuario puede usar. */
  tools: Array<{ name: string; description: string; requiredPermission: string }>;
  knowledgeChunks: number;
}

@Controller('api/v1/agent')
export class AgentController {
  constructor(
    private readonly ask: AskQuestionUseCase,
    private readonly ingest: IngestKnowledgeBaseUseCase,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(VECTOR_STORE) private readonly store: VectorStore,
    @Inject(AGENT_OPTIONS) private readonly options: AgentOptions,
  ) {}

  /**
   * El token del usuario se vuelve a leer de la cabecera para reenviarlo a las herramientas. No
   * se reconstruye ni se firma uno nuevo: el que llega es el que viaja, y cada servicio destino
   * lo valida otra vez.
   */
  @Post('query')
  @RequirePermissions('agent:use')
  query(@Body() dto: AskQuestionDto, @CurrentUser() user: AuthenticatedUser, @Headers('authorization') authorization: string): Promise<AgentAnswer> {
    return this.ask.execute(dto, {
      userId: user.id,
      permissions: user.permissions,
      accessToken: authorization.slice('Bearer '.length),
    });
  }

  /** Lo que la SPA necesita para dibujar la pantalla sin adivinar: modo, modelo y herramientas. */
  @Get('capabilities')
  @RequirePermissions('agent:use')
  async capabilities(@CurrentUser() user: AuthenticatedUser): Promise<AgentCapabilities> {
    return {
      provider: this.llm.primaryModel.startsWith('mock') ? 'mock' : 'gemini',
      model: this.llm.primaryModel,
      fallbackModel: this.llm.fallbackModel,
      embeddingModel: this.embeddings.model,
      promptVersion: this.options.promptVersion,
      tools: toolsFor(user.permissions).map((tool) => ({
        name: tool.schema.name,
        description: tool.schema.description,
        requiredPermission: tool.requiredPermission,
      })),
      knowledgeChunks: await this.store.count().catch(() => 0),
    };
  }

  /** Reindexar es una operación de administración de la base de conocimiento, no de consulta. */
  @Post('knowledge-base/reindex')
  @RequirePermissions('kb:manage')
  reindex(): Promise<IngestResult> {
    return this.ingest.execute({ force: true });
  }
}
