import { Inject, Injectable } from '@nestjs/common';
import { type Actor, createEnvelope, type EventData, type EventType, type IntegrationEvent, type Subject } from '@toka/contracts';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { CLS_CAUSATION_ID, CLS_CORRELATION_ID } from '../context/request-context';

/**
 * Puerto de publicación de eventos de integración. `publish` no lanza: si el broker no confirma,
 * el adaptador registra el evento completo (para poder re-publicarlo) y el request sigue, porque
 * el cambio ya está confirmado en la base. El outbox transaccional (extra) cierra ese hueco.
 */
export interface EventPublisher {
  publish(event: IntegrationEvent): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const SERVICE_NAME = Symbol('SERVICE_NAME');

export interface NewEventInput<T extends EventType> {
  subject: Subject;
  data: EventData<T>;
  actor?: Actor;
}

/** Arma envelopes con productor, correlationId y causationId tomados del contexto actual. */
@Injectable()
export class IntegrationEventFactory {
  constructor(
    @Inject(SERVICE_NAME) private readonly service: string,
    private readonly cls: ClsService,
  ) {}

  create<T extends EventType>(type: T, input: NewEventInput<T>): IntegrationEvent<T> {
    const active = this.cls.isActive();
    const correlationId = (active ? this.cls.get<string>(CLS_CORRELATION_ID) : undefined) ?? randomUUID();
    const causationId = (active ? this.cls.get<string>(CLS_CAUSATION_ID) : undefined) ?? null;
    return createEnvelope({
      type,
      data: input.data,
      subject: input.subject,
      actor: input.actor,
      producer: this.service,
      correlationId,
      causationId,
    }) as IntegrationEvent<T>;
  }
}
