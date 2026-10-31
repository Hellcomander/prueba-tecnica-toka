import { type DynamicModule, Global, Inject, Injectable, Module } from '@nestjs/common';
import { EVENTS } from '@toka/contracts';
import type { AccessDeniedEvent, SecurityEventSink } from '../auth/auth.types';
import {
  AmqpConnection,
  AmqpEventPublisher,
  MESSAGING_OPTIONS,
  type MessagingOptions,
} from '../infrastructure/messaging/amqp-connection';
import { EVENT_PUBLISHER, type EventPublisher, IntegrationEventFactory } from './event-publisher';

/** Publica cada denegación de acceso como `access.denied` para que audit la registre. */
@Injectable()
export class EventPublishingSecurityEventSink implements SecurityEventSink {
  constructor(
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    private readonly factory: IntegrationEventFactory,
  ) {}

  async accessDenied(event: AccessDeniedEvent): Promise<void> {
    await this.publisher.publish(
      this.factory.create(EVENTS.ACCESS_DENIED, {
        subject: { type: 'route', id: `${event.method} ${event.route}` },
        actor: { id: event.userId, type: event.reason === 'wrong_token_use' ? 'service' : 'user' },
        data: event,
      }),
    );
  }
}

@Global()
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingOptions): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        { provide: MESSAGING_OPTIONS, useValue: options },
        AmqpConnection,
        IntegrationEventFactory,
        { provide: EVENT_PUBLISHER, useClass: AmqpEventPublisher },
      ],
      exports: [AmqpConnection, IntegrationEventFactory, EVENT_PUBLISHER],
    };
  }
}
