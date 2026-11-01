import { accessToDomain, directoryToDomain, roleToDomain, roleToRow } from './mappers';

describe('mappers Prisma ↔ dominio', () => {
  it('rol: ida y vuelta sin pérdida, permisos ordenados', () => {
    const row = { id: 'r1', name: 'soporte', description: 'd', permissions: ['users:read', 'audit:read'], isSystem: false, version: 4 };
    const role = roleToDomain(row);
    expect(role.persistedVersion).toBe(4);
    expect(roleToRow(role)).toEqual({ ...row, permissions: ['audit:read', 'users:read'] });
  });

  it('acceso: sin fila es versión 0', () => {
    expect(accessToDomain('u1', null, []).version).toBe(0);
    expect(accessToDomain('u1', { assignmentsVersion: 3 }, ['b', 'a']).roles).toEqual(['a', 'b']);
  });

  it('directorio: cualquier estado desconocido se trata como ACTIVE', () => {
    expect(directoryToDomain({ userId: 'u', email: 'e', status: 'SUSPENDED', statusVersion: 2 }).isActive).toBe(false);
    expect(directoryToDomain({ userId: 'u', email: 'e', status: 'raro', statusVersion: 0 }).isActive).toBe(true);
  });
});
