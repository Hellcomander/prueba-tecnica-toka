import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { IngestKnowledgeBaseUseCase } from '../../application/commands/ingest-knowledge-base.use-case';
import { ENV, type Env } from '../config/env';

/**
 * Indexa la base de conocimiento al arrancar, **sin bloquear el arranque HTTP**: si Qdrant aún
 * no está listo, `/health/live` responde igual y esto reintenta con backoff. La alternativa
 * —esperar a que la ingesta termine para abrir el puerto— convertiría un Qdrant lento en un
 * contenedor que nunca llega a *healthy*.
 *
 * La ingesta es idempotente por hash, así que reintentar no cuesta embeddings de más.
 */
@Injectable()
export class IngestBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly ingest: IngestKnowledgeBaseUseCase,
    @Inject(ENV) private readonly env: Env,
    @InjectPinoLogger(IngestBootstrap.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.AI_INGEST_ON_BOOT) return;
    void this.run();
  }

  private async run(attempt = 1): Promise<void> {
    try {
      const result = await this.ingest.execute();
      this.logger.info({ event: 'kb.ingested', ...result }, 'kb.ingested');
    } catch (err) {
      if (attempt >= 6) {
        this.logger.error({ event: 'kb.ingest_failed', attempt, err }, 'kb.ingest_failed');
        return;
      }
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      this.logger.warn({ event: 'kb.ingest_retry', attempt, delayMs, err }, 'kb.ingest_retry');
      setTimeout(() => void this.run(attempt + 1), delayMs).unref();
    }
  }
}
