import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ActorSchema = z.object({
  id: z.string().min(1).nullable(),
  type: z.enum(['user', 'service', 'system']),
});
export type Actor = z.infer<typeof ActorSchema>;

export const SubjectSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});
export type Subject = z.infer<typeof SubjectSchema>;

/**
 * Envelope común de todos los eventos de integración. Lector tolerante: los campos
 * desconocidos se conservan (looseObject) para que un productor pueda agregar campos sin
 * romper a los consumidores (evolución compatible hacia adelante).
 */
export const EventEnvelopeSchema = z.looseObject({
  eventId: z.uuid(),
  type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, 'type debe ser <contexto>.<evento>'),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  producer: z.string().min(1),
  correlationId: z.string().min(1).max(64),
  causationId: z.string().min(1).nullable(),
  actor: ActorSchema,
  subject: SubjectSchema,
  data: z.unknown(),
});

export interface EventEnvelope<TType extends string = string, TData = unknown> {
  eventId: string;
  type: TType;
  version: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId: string | null;
  actor: Actor;
  subject: Subject;
  data: TData;
}

export interface NewEnvelopeInput<TType extends string, TData> {
  type: TType;
  data: TData;
  producer: string;
  correlationId: string;
  subject: Subject;
  actor?: Actor;
  causationId?: string | null;
  version?: number;
  eventId?: string;
  occurredAt?: Date;
}

export function createEnvelope<TType extends string, TData>(
  input: NewEnvelopeInput<TType, TData>,
): EventEnvelope<TType, TData> {
  return {
    eventId: input.eventId ?? randomUUID(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    producer: input.producer,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    actor: input.actor ?? { id: null, type: 'system' },
    subject: input.subject,
    data: input.data,
  };
}
