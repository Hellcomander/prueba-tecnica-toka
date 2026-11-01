import { UserAccess } from './access/user-access';
import { DirectoryEntry } from './directory/directory-entry';
import { Role, RoleName } from './role/role';
import { DomainError } from './shared/domain-error';

const ADMIN = 'role-admin';
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

describe('RoleName', () => {
  it('normaliza a minúsculas y valida formato', () => {
    expect(RoleName.of('  Soporte_N1 ').value).toBe('soporte_n1');
    expect(code(() => RoleName.of('ab'))).toBe('INVALID_ROLE_NAME');
    expect(code(() => RoleName.of('con espacio'))).toBe('INVALID_ROLE_NAME');
    expect(code(() => RoleName.of('9empieza'))).toBe('INVALID_ROLE_NAME');
  });
});

describe('Role', () => {
  const custom = () => Role.restore({ id: 'r1', name: 'soporte', description: 'd', permissions: ['users:read'], isSystem: false, version: 3 });

  it('create normaliza permisos, exige al menos uno y registra RoleCreated', () => {
    const role = Role.create({ id: 'r1', name: 'Soporte', permissions: ['users:read', 'users:read', 'audit:read'] });
    expect(role.permissions).toEqual(['audit:read', 'users:read']);
    expect(role.version).toBe(1);
    expect(role.pullDomainEvents()).toEqual([{ type: 'RoleCreated', roleId: 'r1', name: 'soporte', permissions: ['audit:read', 'users:read'] }]);
    expect(role.pullDomainEvents()).toEqual([]);
    expect(code(() => Role.create({ id: 'r2', name: 'vacio', permissions: [] }))).toBe('EMPTY_PERMISSIONS');
  });

  it('update incrementa la versión una sola vez, detecta renombre y no hace nada si no cambia', () => {
    const role = custom();
    expect(role.update({ description: 'd' })).toEqual({ renamed: false });
    expect(role.version).toBe(3);
    expect(role.pullDomainEvents()).toEqual([]);

    expect(role.update({ name: 'soporte-n2', permissions: ['users:read', 'roles:read'] })).toEqual({ renamed: true });
    expect(role.version).toBe(4);
    role.update({ description: 'otra' });
    expect(role.version).toBe(4);
    expect(role.pullDomainEvents().map((e) => e.type)).toEqual(['RoleUpdated', 'RoleUpdated']);
  });

  it('assertVersion detecta ediciones concurrentes', () => {
    expect(code(() => custom().assertVersion(2))).toBe('VERSION_CONFLICT');
    expect(code(() => custom().assertVersion(3))).toBe('ok');
  });

  it('los roles de sistema no se modifican ni se borran; un rol con miembros no se borra', () => {
    const admin = Role.system({ id: ADMIN, name: 'admin', description: 'x', permissions: ['users:write'] });
    expect(admin.isSystem).toBe(true);
    expect(code(() => admin.update({ description: 'nuevo' }))).toBe('SYSTEM_ROLE_IMMUTABLE');
    expect(code(() => admin.markDeleted(0))).toBe('SYSTEM_ROLE_IMMUTABLE');
    expect(code(() => custom().markDeleted(2))).toBe('ROLE_IN_USE');
    const role = custom();
    role.markDeleted(0);
    expect(role.pullDomainEvents()).toEqual([{ type: 'RoleDeleted', roleId: 'r1', name: 'soporte' }]);
  });
});

describe('UserAccess: regla del último admin', () => {
  const adminAccess = (userId = 'u1') => UserAccess.restore({ userId, roleIds: [ADMIN, 'viewer'], assignmentsVersion: 2 });
  const guard = (over: Partial<{ actorId: string | null; userIsActive: boolean; otherActiveAdmins: number }> = {}) => ({
    adminRoleId: ADMIN,
    actorId: 'otro-admin',
    userIsActive: true,
    otherActiveAdmins: 1,
    ...over,
  });

  it('quitar admin con otro admin activo funciona y registra el snapshot con versión nueva', () => {
    const access = adminAccess();
    expect(access.replaceRoles(['viewer'], guard())).toBe(true);
    expect(access.roles).toEqual(['viewer']);
    expect(access.version).toBe(3);
    expect(access.pullDomainEvents()).toEqual([{ type: 'UserRolesChanged', userId: 'u1', roleIds: ['viewer'], assignmentsVersion: 3 }]);
  });

  it('no se puede dejar al sistema sin admins activos', () => {
    expect(code(() => adminAccess().replaceRoles(['viewer'], guard({ otherActiveAdmins: 0 })))).toBe('LAST_ADMIN');
  });

  it('un admin suspendido no cuenta: se le puede quitar el rol aunque no haya otros', () => {
    expect(adminAccess().replaceRoles(['viewer'], guard({ otherActiveAdmins: 0, userIsActive: false }))).toBe(true);
  });

  it('nadie se quita a sí mismo el rol admin', () => {
    expect(code(() => adminAccess('u1').replaceRoles(['viewer'], guard({ actorId: 'u1', otherActiveAdmins: 5 })))).toBe('SELF_ADMIN_REMOVAL');
  });

  it('sin cambios no hay evento ni nueva versión; el rol por defecto solo se asigna si no tiene ninguno', () => {
    const access = adminAccess();
    expect(access.replaceRoles(['viewer', ADMIN], guard())).toBe(false);
    expect(access.version).toBe(2);
    expect(access.assignDefaultIfEmpty('viewer')).toBe(false);
    const fresh = UserAccess.restore({ userId: 'n', roleIds: [], assignmentsVersion: 0 });
    expect(fresh.assignDefaultIfEmpty('viewer')).toBe(true);
    expect(fresh.roles).toEqual(['viewer']);
    expect(fresh.version).toBe(1);
  });

  it('touch re-emite el snapshot y assertVersion detecta concurrencia', () => {
    const access = adminAccess();
    access.touch();
    expect(access.version).toBe(3);
    expect(access.pullDomainEvents()).toHaveLength(1);
    expect(code(() => adminAccess().assertVersion(1))).toBe('VERSION_CONFLICT');
    expect(adminAccess().hasRole(ADMIN)).toBe(true);
  });
});

describe('DirectoryEntry', () => {
  it('aplica solo cambios de estado más nuevos (eventos desordenados)', () => {
    const entry = DirectoryEntry.registered('u1', 'a@toka.test');
    expect(entry.isActive).toBe(true);
    expect(entry.applyStatus('SUSPENDED', 2)).toBe(true);
    expect(entry.applyStatus('ACTIVE', 1)).toBe(false);
    expect(entry.status).toBe('SUSPENDED');
    expect(entry.statusVersion).toBe(2);
    expect(entry.isActive).toBe(false);
  });
});
