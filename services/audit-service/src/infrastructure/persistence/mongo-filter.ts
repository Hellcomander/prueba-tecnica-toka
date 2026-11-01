import type { AuditFilter } from '../../application/ports';

/** Orden de lectura = orden de los índices `{ occurredAt: -1, _id: -1 }` de init. */
export const READ_ORDER = { occurredAt: -1, _id: -1 } as const;

/**
 * Traduce el filtro de la aplicación a una consulta de Mongo. Función pura: la parte con lógica
 * del adaptador (rangos y cursor) se prueba sin base de datos.
 *
 * Cursor: "estrictamente después" en orden descendente =
 *   occurredAt < t  OR  (occurredAt = t AND _id < id)
 */
export function buildMongoFilter(filter: AuditFilter): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  if (filter.type) clauses.push({ type: filter.type });
  if (filter.category) clauses.push({ category: filter.category });
  if (filter.actorId) clauses.push({ 'actor.id': filter.actorId });
  if (filter.from) clauses.push({ occurredAt: { $gte: filter.from } });
  if (filter.to) clauses.push({ occurredAt: { $lte: filter.to } });
  if (filter.after) {
    clauses.push({
      $or: [{ occurredAt: { $lt: filter.after.occurredAt } }, { occurredAt: filter.after.occurredAt, _id: { $lt: filter.after.id } }],
    });
  }
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? (clauses[0] as Record<string, unknown>) : { $and: clauses };
}
