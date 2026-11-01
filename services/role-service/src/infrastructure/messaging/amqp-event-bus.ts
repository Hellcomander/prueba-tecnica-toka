import { Inject, Injectable } from '@nestjs/common';
import { EVENT_PUBLISHER, type EventPublisher, IntegrationEventFactory } from '@toka/nest-common';
import type { EventBus, OutboundEvent } from '../../application/ports';

/** Adaptador del puerto EventBus: arma el envelope (productor, correlationId) y publica en RabbitMQ. */
@Injectable()
export class AmqpEventBus implements EventBus {
  constructor(
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly factory: IntegrationEventFactory,
  ) {}

  async publish(events: OutboundEvent[]): Promise<void> {
    for (const event of events) {
      await this.publisher.publish(this.factory.create(event.type, { subject: event.subject, data: event.data, actor: event.actor }));
    }
  }
}
