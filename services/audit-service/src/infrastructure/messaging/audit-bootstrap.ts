import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { parseEnvelope, QUEUES } from '@toka/contracts';
import { AmqpConnection } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { RecordAuditEventUseCase } from '../../application/record-audit-event.use-case';

/**
 * Consume `audit-service.all` (binding `#`). Valida solo el envelope (`parseEnvelope`): audit
 * registra cualquier evento, incluso tipos que todavía no existen en el catálogo.
 * Error de Mongo → se relanza y el mensaje se reintenta / va a la DLQ; una clave duplicada no
 * llega aquí porque el repositorio la absorbe.
 */
@Injectable()
export class AuditBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly amqp: AmqpConnection,
    private readonly record: RecordAuditEventUseCase,
    @InjectPinoLogger(AuditBootstrap.name) private readonly logger: PinoLogger,
  ) {}

  /** No bloquea el arranque HTTP: si el broker tarda, /health/live responde igual y esto reintenta. */
  onApplicationBootstrap(): void {
    void this.start();
  }

  private async start(attempt = 1): Promise<void> {
    try {
      await this.amqp.waitUntilReady();
      await this.amqp.consume(QUEUES.audit, parseEnvelope, async (event) => {
        const recorded = await this.record.execute(event);
        if (!recorded) this.logger.info({ event: 'audit.duplicate_ignored', eventId: event.eventId, type: event.type }, 'audit.duplicate_ignored');
      });
    } catch (err) {
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      this.logger.warn({ event: 'bootstrap.retry', attempt, delayMs, err }, 'bootstrap.retry');
      setTimeout(() => void this.start(attempt + 1), delayMs).unref();
    }
  }
}
