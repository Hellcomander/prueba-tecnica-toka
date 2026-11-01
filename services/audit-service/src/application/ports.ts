import type { Actor, AuditCategory, Subject } from '@toka/contracts';

/**
 * Entrada de auditoría = el envelope del evento tal cual llegó + la categoría derivada.
 * Es un registro plano (no un agregado): se inserta una vez y nunca cambia.
 * `eventId` es la clave primaria (`_id` en Mongo): de ahí sale la idempotencia.
 */
export interface AuditEntry {
  eventId: string;
  type: string;
  category: AuditCategory;
  version: number;
  occurredAt: Date;
  producer: string;
  correlationId: string;
  causationId: string | null;
  actor: Actor;
  subject: Subject;
  data: unknown;
}

export interface AuditFilter {
  type?: string;
  category?: AuditCategory;
  actorId?: string;
  from?: Date;
  to?: Date;
  /** Posición del cursor: solo entradas estrictamente anteriores a (occurredAt, id) en el orden de lectura. */
  after?: { occurredAt: Date; id: string };
}

export interface AuditStatsSnapshot {
  total: number;
  last24h: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
}

/**
 * Puerto del read model. Solo existen operaciones de alta y lectura: no hay update ni delete
 * en el contrato, así que ni el código ni el usuario de Mongo pueden alterar el historial.
 */
export interface AuditRepository {
  /** Inserta la entrada. Devuelve `false` si el `eventId` ya existía (re-entrega): no es un error. */
  append(entry: AuditEntry): Promise<boolean>;
  /** Orden fijo: `occurredAt` descendente y `_id` descendente (desempate). */
  find(filter: AuditFilter, limit: number): Promise<AuditEntry[]>;
  stats(since: Date): Promise<AuditStatsSnapshot>;
}

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
