import { Inject, Injectable } from '@nestjs/common';
import { EVENTS } from '@toka/contracts';
import { EVENT_PUBLISHER, type EventPublisher, IntegrationEventFactory } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AgentEventSink } from '../../application/ports';

type QueryCompleted = Parameters<AgentEventSink['queryCompleted']>[0];

/**
 * Publica `agent.query_completed` y deja la misma información en el log JSON.
 *
 * El evento **no lleva la pregunta ni la respuesta**, solo el hash de la pregunta: la auditoría
 * necesita saber que alguien consultó al asistente, cuánto costó y si el validador pasó — no
 * necesita el contenido, que puede incluir nombres de personas. Con el hash se puede agrupar
 * "esta misma pregunta se hizo 40 veces" sin guardar el texto.
 */
@Injectable()
export class AmqpAgentEventSink implements AgentEventSink {
  constructor(
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly factory: IntegrationEventFactory,
    @InjectPinoLogger(AmqpAgentEventSink.name) private readonly logger: PinoLogger,
  ) {}

  async queryCompleted(event: QueryCompleted): Promise<void> {
    this.logger.info({ event: 'agent.query_completed', ...event }, 'agent.query_completed');
    if (event.flags.some((flag) => flag.startsWith('injection:'))) {
      this.logger.warn({ event: 'agent.injection_suspected', userId: event.userId, flags: event.flags }, 'agent.injection_suspected');
    }
    await this.publisher.publish(
      this.factory.create(EVENTS.AGENT_QUERY_COMPLETED, {
        subject: { type: 'user', id: event.userId },
        data: event,
        actor: { type: 'user', id: event.userId },
      }),
    );
  }
}
