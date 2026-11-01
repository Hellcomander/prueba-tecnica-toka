import { randomUUID } from 'node:crypto';
import { createEnvelope, type EventEnvelope } from '@toka/contracts';

/** Envelope válido de cualquier tipo (audit no valida el payload, solo el envelope). */
export const envelope = (over: { type?: string; at?: string; actorId?: string | null; eventId?: string; data?: unknown } = {}): EventEnvelope =>
  createEnvelope({
    type: over.type ?? 'auth.login_succeeded',
    producer: 'auth-service',
    correlationId: 'corr-1',
    subject: { type: 'user', id: 'u-1' },
    actor: { id: over.actorId === undefined ? 'u-1' : over.actorId, type: 'user' },
    eventId: over.eventId ?? randomUUID(),
    occurredAt: over.at ? new Date(over.at) : undefined,
    data: over.data ?? { ok: true },
  });
