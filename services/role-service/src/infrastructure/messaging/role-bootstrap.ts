import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENTS, parseEvent, QUEUES } from '@toka/contracts';
import { AmqpConnection } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SeedRolesUseCase } from '../../application/commands/seed-roles.use-case';
import { type ConsumedEvent, RoleEventHandlers } from '../../application/events/role-event-handlers';
import { ENV, type Env } from '../config/env';

/**
 * Orden de arranque: 1) broker listo, 2) siembra (roles de sistema y usuarios demo), 3) recién
 * entonces empezar a consumir. Así el `account.registered` del admin, que puede estar esperando
 * en la cola, no le asigna `viewer` antes de que la siembra le dé `admin`.
 */
@Injectable()
export class RoleBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly amqp: AmqpConnection,
    private readonly seed: SeedRolesUseCase,
    private readonly handlers: RoleEventHandlers,
    @Inject(ENV) private readonly env: Env,
    @InjectPinoLogger(RoleBootstrap.name) private readonly logger: PinoLogger,
  ) {}

  /** No bloquea el arranque HTTP: si el broker tarda, /health/live responde igual y esto reintenta. */
  onApplicationBootstrap(): void {
    void this.start();
  }

  private async start(attempt = 1): Promise<void> {
    try {
      await this.amqp.waitUntilReady();
      const result = await this.seed.execute({ demoUsers: this.env.SEED_DEMO_DATA });
      this.logger.info({ event: 'seed.completed', ...result }, 'seed.completed');
      await this.amqp.consume(
        QUEUES.role,
        (raw) => parseEvent(raw, [EVENTS.ACCOUNT_REGISTERED, EVENTS.USER_STATUS_CHANGED]) as ConsumedEvent,
        (event) => this.handlers.handle(event),
      );
    } catch (err) {
      const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
      this.logger.warn({ event: 'bootstrap.retry', attempt, delayMs, err }, 'bootstrap.retry');
      setTimeout(() => void this.start(attempt + 1), delayMs).unref();
    }
  }
}
