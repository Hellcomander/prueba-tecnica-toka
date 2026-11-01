import { Inject, Injectable } from '@nestjs/common';
import { eventCategory, type EventEnvelope } from '@toka/contracts';
import { AUDIT_REPOSITORY, type AuditEntry, type AuditRepository } from './ports';

/**
 * Único camino de escritura. Sin transacción, sin tabla de eventos procesados y sin publicar
 * nada: la idempotencia es la clave duplicada (`_id = eventId`) que el repositorio absorbe.
 */
@Injectable()
export class RecordAuditEventUseCase {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly entries: AuditRepository) {}

  /** `true` si se registró; `false` si era una re-entrega ya registrada. */
  execute(event: EventEnvelope): Promise<boolean> {
    return this.entries.append({
      eventId: event.eventId,
      type: event.type,
      category: eventCategory(event.type),
      version: event.version,
      occurredAt: new Date(event.occurredAt),
      producer: event.producer,
      correlationId: event.correlationId,
      causationId: event.causationId,
      actor: event.actor,
      subject: event.subject,
      data: event.data,
    });
  }
}

export const toAuditView = (entry: AuditEntry) => ({
  eventId: entry.eventId,
  type: entry.type,
  category: entry.category,
  version: entry.version,
  occurredAt: entry.occurredAt.toISOString(),
  producer: entry.producer,
  correlationId: entry.correlationId,
  causationId: entry.causationId,
  actor: entry.actor,
  subject: entry.subject,
  data: entry.data,
});

export type AuditEntryView = ReturnType<typeof toAuditView>;
