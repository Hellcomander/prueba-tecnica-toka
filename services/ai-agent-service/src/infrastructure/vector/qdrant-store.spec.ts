import { aclFilter, pointId } from './qdrant-store';

/**
 * El ACL se arma aquí y se aplica dentro de la consulta a Qdrant, así que un error en esta
 * función es un fallo de autorización, no un detalle de formato. La forma concreta importa:
 * la primera versión metía `null` dentro de `match.any` y Qdrant la rechazaba con un 400
 * (`data did not match any variant of untagged enum MatchInterface`), lo que convertía toda
 * consulta del agente en un 503.
 */
describe('filtro ACL para Qdrant', () => {
  it('ofrece dos ramas: pasajes públicos o con un permiso que el usuario tiene', () => {
    expect(aclFilter(['audit:read', 'users:read'])).toEqual({
      should: [{ is_null: { key: 'requiredPermission' } }, { key: 'requiredPermission', match: { any: ['audit:read', 'users:read'] } }],
    });
  });

  it('nunca mete null dentro de match.any: es lo que Qdrant rechaza con un 400', () => {
    const should = aclFilter(['users:read']).should as Array<{ match?: { any: unknown[] } }>;
    const matchClause = should.find((clause) => clause.match);
    expect(matchClause?.match?.any).toEqual(['users:read']);
    expect(matchClause?.match?.any.some((v) => v === null)).toBe(false);
  });

  it('sin permisos solo queda lo público, no "todo"', () => {
    const filter = aclFilter([]);
    expect(filter).toEqual({ should: [{ is_null: { key: 'requiredPermission' } }] });
    expect(JSON.stringify(filter)).not.toContain('match');
  });
});

describe('identificador de punto', () => {
  it('es un UUID estable derivado del id legible del chunk', () => {
    expect(pointId('politica#0')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(pointId('politica#0')).toBe(pointId('politica#0'));
    expect(pointId('politica#0')).not.toBe(pointId('politica#1'));
  });
});
