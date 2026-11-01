import { UserProfile } from './profile/user-profile';
import { UserRolesProjection } from './projection/user-roles-projection';
import type { DomainError } from './shared/domain-error';

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

const fresh = () => UserProfile.register({ id: 'u1', email: '  Ana@Toka.Test ', fullName: ' Ana Admin ', department: 'TI', jobTitle: '' });
const persisted = (over: Partial<Parameters<typeof UserProfile.restore>[0]> = {}) =>
  UserProfile.restore({
    id: 'u1',
    email: 'ana@toka.test',
    fullName: 'Ana',
    department: null,
    jobTitle: null,
    status: 'ACTIVE',
    statusReason: null,
    version: 3,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });
const guard = (over: Partial<{ actorId: string | null; targetIsAdmin: boolean; otherActiveAdmins: number }> = {}) => ({
  actorId: 'someone-else',
  targetIsAdmin: false,
  otherActiveAdmins: 1,
  ...over,
});

describe('UserProfile.register', () => {
  it('normaliza email y textos, nace ACTIVE en versión 1 y no registra eventos', () => {
    const p = fresh();
    expect(p).toMatchObject({ email: 'ana@toka.test', fullName: 'Ana Admin', department: 'TI', jobTitle: null, status: 'ACTIVE', version: 1, persistedVersion: 0 });
    expect(p.pullDomainEvents()).toEqual([]);
  });

  it('rechaza nombre vacío o demasiado largo y textos opcionales largos', () => {
    expect(code(() => UserProfile.register({ id: 'u', email: 'a@b.c', fullName: '   ' }))).toBe('INVALID_FULL_NAME');
    expect(code(() => UserProfile.register({ id: 'u', email: 'a@b.c', fullName: 'x'.repeat(121) }))).toBe('INVALID_FULL_NAME');
    expect(code(() => UserProfile.register({ id: 'u', email: 'a@b.c', fullName: 'Ok', department: 'x'.repeat(81) }))).toBe('INVALID_DEPARTMENT');
    expect(code(() => UserProfile.register({ id: 'u', email: 'a@b.c', fullName: 'Ok', jobTitle: 'x'.repeat(81) }))).toBe('INVALID_JOB_TITLE');
  });
});

describe('UserProfile.update', () => {
  it('incrementa la versión una sola vez y reporta solo los campos que cambiaron', () => {
    const p = persisted({ department: 'TI' });
    expect(p.update({ fullName: 'Ana María', department: 'TI', jobTitle: 'Líder' })).toEqual(['fullName', 'jobTitle']);
    expect(p.version).toBe(4);
    expect(p.persistedVersion).toBe(3);
    expect(p.pullDomainEvents()).toEqual([{ type: 'ProfileUpdated', userId: 'u1', changedFields: ['fullName', 'jobTitle'], version: 4 }]);
  });

  it('sin cambios no hay evento ni nueva versión; null o "" borran un campo opcional', () => {
    const p = persisted({ department: 'TI' });
    expect(p.update({ fullName: 'Ana', department: 'TI' })).toEqual([]);
    expect(p.version).toBe(3);
    expect(p.pullDomainEvents()).toEqual([]);
    expect(p.update({ department: null })).toEqual(['department']);
    expect(p.department).toBeNull();
    expect(persisted({ jobTitle: 'Dev' }).update({ jobTitle: '' })).toEqual(['jobTitle']);
  });

  it('valida los campos y deja el agregado intacto si algo falla', () => {
    const p = persisted();
    expect(code(() => p.update({ fullName: ' ' }))).toBe('INVALID_FULL_NAME');
    expect(code(() => p.update({ fullName: 'Nuevo', jobTitle: 'x'.repeat(81) }))).toBe('INVALID_JOB_TITLE');
    expect(p.fullName).toBe('Ana');
    expect(p.version).toBe(3);
  });

  it('assertVersion detecta concurrencia', () => {
    expect(code(() => persisted().assertVersion(2))).toBe('VERSION_CONFLICT');
    expect(code(() => persisted().assertVersion(3))).toBe('ok');
  });
});

describe('UserProfile.suspend', () => {
  it('suspende, guarda el motivo y registra StatusChanged con la versión del agregado', () => {
    const p = persisted();
    p.suspend('  baja temporal ', guard());
    expect(p).toMatchObject({ status: 'SUSPENDED', statusReason: 'baja temporal', version: 4, isActive: false });
    expect(p.pullDomainEvents()).toEqual([
      { type: 'StatusChanged', userId: 'u1', status: 'SUSPENDED', previousStatus: 'ACTIVE', reason: 'baja temporal', version: 4 },
    ]);
  });

  it('nadie se suspende a sí mismo (aunque haya otros admins)', () => {
    expect(code(() => persisted().suspend(undefined, guard({ actorId: 'u1', targetIsAdmin: true, otherActiveAdmins: 5 })))).toBe('SELF_SUSPENSION');
  });

  it('no se suspende al último admin activo, pero sí a un admin si queda otro', () => {
    expect(code(() => persisted().suspend(undefined, guard({ targetIsAdmin: true, otherActiveAdmins: 0 })))).toBe('LAST_ADMIN');
    expect(code(() => persisted().suspend(undefined, guard({ targetIsAdmin: true, otherActiveAdmins: 1 })))).toBe('ok');
  });

  it('un usuario sin rol admin se suspende aunque no haya admins; el sistema (actorId null) puede suspender', () => {
    expect(code(() => persisted().suspend(undefined, guard({ otherActiveAdmins: 0 })))).toBe('ok');
    expect(code(() => persisted().suspend(undefined, guard({ actorId: null })))).toBe('ok');
  });

  it('un usuario ya suspendido no se vuelve a suspender; el último admin suspendido no se re-evalúa', () => {
    const p = persisted({ status: 'SUSPENDED' });
    expect(code(() => p.suspend(undefined, guard({ targetIsAdmin: true, otherActiveAdmins: 0 })))).toBe('ALREADY_SUSPENDED');
  });

  it('valida el largo del motivo y la cadena vacía cuenta como sin motivo', () => {
    expect(code(() => persisted().suspend('x'.repeat(201), guard()))).toBe('INVALID_REASON');
    const p = persisted();
    p.suspend('   ', guard());
    expect(p.statusReason).toBeNull();
  });
});

describe('UserProfile.reactivate', () => {
  it('reactiva, limpia el motivo de suspensión y registra el evento con el motivo recibido', () => {
    const p = persisted({ status: 'SUSPENDED', statusReason: 'baja' });
    p.reactivate('regresó');
    expect(p).toMatchObject({ status: 'ACTIVE', statusReason: null, version: 4 });
    expect(p.pullDomainEvents()).toEqual([
      { type: 'StatusChanged', userId: 'u1', status: 'ACTIVE', previousStatus: 'SUSPENDED', reason: 'regresó', version: 4 },
    ]);
  });

  it('un usuario activo no se reactiva', () => {
    expect(code(() => persisted().reactivate())).toBe('ALREADY_ACTIVE');
  });
});

describe('UserRolesProjection', () => {
  it('sin snapshot es vacía, versión 0 y no es admin', () => {
    const p = UserRolesProjection.empty('u1');
    expect(p).toMatchObject({ roles: [], version: 0, persistedVersion: 0, isAdmin: false });
  });

  it('aplica solo snapshots más nuevos (eventos desordenados) y deduplica y ordena los roles', () => {
    const p = UserRolesProjection.empty('u1');
    expect(p.apply(['viewer', 'admin', 'viewer'], 2)).toBe(true);
    expect(p.roles).toEqual(['admin', 'viewer']);
    expect(p.isAdmin).toBe(true);
    expect(p.apply(['viewer'], 1)).toBe(false);
    expect(p.apply(['viewer'], 2)).toBe(false);
    expect(p.isAdmin).toBe(true);
    expect(p.apply(['viewer'], 3)).toBe(true);
    expect(p).toMatchObject({ isAdmin: false, version: 3, persistedVersion: 0 });
  });
});
