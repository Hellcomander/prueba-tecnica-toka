import { profileToDomain, profileToRow, projectionToDomain, rowToView, statusOf } from './mappers';

const row = {
  id: 'u1',
  email: 'a@toka.test',
  fullName: 'Ana',
  department: null,
  jobTitle: 'Dev',
  status: 'SUSPENDED',
  statusReason: 'baja',
  version: 4,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('mappers Prisma ↔ dominio', () => {
  it('perfil: ida y vuelta sin pérdida y versión persistida', () => {
    const profile = profileToDomain(row);
    expect(profile.persistedVersion).toBe(4);
    expect(profile.isActive).toBe(false);
    expect(profileToRow(profile)).toEqual(row);
  });

  it('cualquier estado desconocido se trata como ACTIVE', () => {
    expect(statusOf('SUSPENDED')).toBe('SUSPENDED');
    expect(statusOf('raro')).toBe('ACTIVE');
  });

  it('proyección: sin fila es vacía y versión 0; con fila ordena los roles', () => {
    expect(projectionToDomain('u1', null)).toMatchObject({ roles: [], version: 0 });
    expect(projectionToDomain('u1', { roles: ['viewer', 'admin'], assignmentsVersion: 3 }).roles).toEqual(['admin', 'viewer']);
  });

  it('vista: fechas ISO y roles ordenados', () => {
    expect(rowToView(row, ['b', 'a'])).toMatchObject({ roles: ['a', 'b'], status: 'SUSPENDED', createdAt: '2026-01-01T00:00:00.000Z' });
  });
});
