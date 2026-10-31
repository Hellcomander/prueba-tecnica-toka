/**
 * Catálogo de permisos y roles de sistema: el "lenguaje publicado" de autorización.
 * Los servicios comparan contra estas constantes; role-service es dueño de las asignaciones.
 */
export const PERMISSIONS = [
  'users:read',
  'users:write',
  'roles:read',
  'roles:write',
  'roles:assign',
  'audit:read',
  'agent:use',
  'kb:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  'users:read': 'Consultar usuarios y estadísticas',
  'users:write': 'Crear, editar, suspender y reactivar usuarios',
  'roles:read': 'Consultar roles, permisos y asignaciones',
  'roles:write': 'Crear, editar y eliminar roles',
  'roles:assign': 'Asignar y quitar roles a usuarios',
  'audit:read': 'Consultar la auditoría',
  'agent:use': 'Usar el asistente de IA',
  'kb:manage': 'Administrar la base de conocimiento del asistente',
};

export const SYSTEM_ROLES = {
  admin: [...PERMISSIONS],
  auditor: ['users:read', 'roles:read', 'audit:read', 'agent:use'],
  viewer: ['users:read', 'roles:read', 'agent:use'],
} as const satisfies Record<string, readonly Permission[]>;

export type SystemRoleName = keyof typeof SYSTEM_ROLES;

export const ADMIN_ROLE: SystemRoleName = 'admin';
export const DEFAULT_ROLE: SystemRoleName = 'viewer';

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
