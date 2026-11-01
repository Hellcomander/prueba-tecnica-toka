import { buildMongoFilter, READ_ORDER } from './mongo-filter';

describe('buildMongoFilter', () => {
  const t = new Date('2026-01-01T00:00:00Z');

  it('sin filtros: consulta vacía', () => {
    expect(buildMongoFilter({})).toEqual({});
  });

  it('un solo criterio no se envuelve en $and', () => {
    expect(buildMongoFilter({ type: 'role.created' })).toEqual({ type: 'role.created' });
  });

  it('combina criterios con $and y mapea actorId a actor.id', () => {
    expect(buildMongoFilter({ category: 'ACCESS', actorId: 'u1', from: t, to: t })).toEqual({
      $and: [{ category: 'ACCESS' }, { 'actor.id': 'u1' }, { occurredAt: { $gte: t } }, { occurredAt: { $lte: t } }],
    });
  });

  it('el cursor es (occurredAt < t) OR (occurredAt = t AND _id < id), el orden de los índices', () => {
    expect(buildMongoFilter({ after: { occurredAt: t, id: 'x' } })).toEqual({
      $or: [{ occurredAt: { $lt: t } }, { occurredAt: t, _id: { $lt: 'x' } }],
    });
    expect(READ_ORDER).toEqual({ occurredAt: -1, _id: -1 });
  });
});
