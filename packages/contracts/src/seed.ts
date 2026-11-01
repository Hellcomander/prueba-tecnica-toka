/**
 * Usuarios de demostración con IDs fijos. auth-service crea sus cuentas (las contraseñas viven
 * solo en la configuración de auth) y role-service les asigna el rol al sembrar, antes de que
 * llegue su `account.registered`. Son datos sintéticos.
 */
export const DEMO_USERS = {
  admin: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@toka.local', fullName: 'Ana Admin', role: 'admin' },
  auditor: { id: '00000000-0000-4000-8000-000000000002', email: 'auditor@toka.local', fullName: 'Aldo Auditor', role: 'auditor' },
  viewer: { id: '00000000-0000-4000-8000-000000000003', email: 'viewer@toka.local', fullName: 'Vera Viewer', role: 'viewer' },
} as const;

/** IDs fijos de los roles de sistema, iguales en todos los ambientes. */
export const SYSTEM_ROLE_IDS = {
  admin: '00000000-0000-4000-9000-000000000001',
  auditor: '00000000-0000-4000-9000-000000000002',
  viewer: '00000000-0000-4000-9000-000000000003',
} as const;
