import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENTS, parseEvent, QUEUES } from '@toka/contracts';
import { AmqpConnection } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SeedAccountsUseCase } from '../../application/commands/seed-accounts.use-case';
import { AuthEventHandlers, type ConsumedEvent } from '../../application/events/auth-event-handlers';
import { ENV, type Env } from '../config/env';
import { FileKeyStore } from '../keys/key-store';

/**
 * Orden de arranque: 1) la llave de firma (sin ella no hay JWKS ni tokens), 2) el broker,
 * 3) la siembra de cuentas demo, 4) recién entonces consumir eventos.
 *
 * La llave se carga aparte y primero: si RabbitMQ tarda en levantar, el discovery y el JWKS ya
 * responden, que es lo que los otros servicios necesitan para validar tokens.
 */
@Injectable()
export class AuthBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly amqp: AmqpConnection,
    private readonly keys: FileKeyStore,
    private readonly seed: SeedAccountsUseCase,
    private readonly handlers: AuthEventHandlers,
    @Inject(ENV) private readonly env: Env,
    @InjectPinoLogger(AuthBootstrap.name) private readonly logger: PinoLogger,
  ) {}

  /** No bloquea el arranque HTTP: si el broker tarda, /health/live responde igual y esto reintenta. */
  onApplicationBootstrap(): void {
    void this.start();
  }

  private async start(attempt = 1): Promise<void> {
    try {
      const key = await this.keys.load();
      this.logger.info({ event: 'keys.loaded', kid: key.kid }, 'keys.loaded');
      await this.amqp.waitUntilReady();
      const result = await this.seed.execute({ demoUsers: this.env.SEED_DEMO_DATA });
      this.logger.info({ event: 'seed.completed', ...result }, 'seed.completed');
      await this.amqp.consume(
        QUEUES.auth,
        (raw) => parseEvent(raw, [EVENTS.USER_STATUS_CHANGED]) as ConsumedEvent,
        (event) => this.handlers.handle(event),
      );
    } catch (err) {
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      this.logger.warn({ event: 'bootstrap.retry', attempt, delayMs, err }, 'bootstrap.retry');
      setTimeout(() => void this.start(attempt + 1), delayMs).unref();
    }
  }
}
