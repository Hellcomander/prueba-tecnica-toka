import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENTS, parseEvent, QUEUES } from '@toka/contracts';
import { AmqpConnection, NonRetryableError } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { type ConsumedEvent, UserEventHandlers } from '../../application/events/user-event-handlers';
import { DomainError } from '../../domain/shared/domain-error';

/** Arranque de los consumidores: sin bloquear el arranque HTTP y con reintento si el broker aún no está. */
@Injectable()
export class UserBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly amqp: AmqpConnection,
    private readonly handlers: UserEventHandlers,
    @InjectPinoLogger(UserBootstrap.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    void this.start();
  }

  private async start(attempt = 1): Promise<void> {
    try {
      await this.amqp.waitUntilReady();
      await this.amqp.consume(
        QUEUES.user,
        (raw) => parseEvent(raw, [EVENTS.ACCOUNT_REGISTERED, EVENTS.ROLE_ASSIGNMENTS_CHANGED]) as ConsumedEvent,
        async (event) => {
          try {
            await this.handlers.handle(event);
          } catch (err) {
            // Una regla de negocio violada (p. ej. EMAIL_TAKEN) no se arregla reintentando: directo a la DLQ.
            if (err instanceof DomainError) throw new NonRetryableError(err.message);
            throw err;
          }
        },
      );
    } catch (err) {
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      this.logger.warn({ event: 'bootstrap.retry', attempt, delayMs, err }, 'bootstrap.retry');
      setTimeout(() => void this.start(attempt + 1), delayMs).unref();
    }
  }
}
