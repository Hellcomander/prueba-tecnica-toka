import type { Permission } from '@toka/contracts';
import type { ToolSchema } from '../../domain/ports';

/**
 * Catálogo de herramientas: siete, **todas de solo lectura**, cada una atada al permiso que ya
 * exige el endpoint al que llama. Al modelo solo se le declaran las que el usuario puede usar,
 * así que un `viewer` no ve siquiera que existe `get_audit_events`: no puede pedir algo cuya
 * existencia desconoce, y si lo pidiera, el servicio destino volvería a rechazarlo con el JWT
 * reenviado. Son dos candados independientes a propósito.
 *
 * Los parámetros se declaran con JSON Schema y `additionalProperties: false`: lo que el modelo
 * invente de más no llega a la petición HTTP.
 */

export interface ToolDefinition {
  schema: ToolSchema;
  requiredPermission: Permission;
  /** Ruta del microservicio destino, con `{placeholders}` para los parámetros de camino. */
  method: 'GET';
  path: string;
  /** Parámetros que viajan en la query string (el resto son de camino). */
  queryParams: readonly string[];
  /** Destino lógico, para elegir el cliente HTTP y para los logs. */
  target: 'user' | 'role' | 'audit';
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra });

export const TOOLS: readonly ToolDefinition[] = [
  {
    schema: {
      name: 'search_users',
      description:
        'Busca usuarios del directorio por nombre o correo y permite filtrar por estado. Devuelve una página de resultados con id, nombre, correo, área, puesto y estado.',
      parameters: object({
        search: str('Texto a buscar en nombre o correo. Omitir para listar todos.', { maxLength: 100 }),
        status: str('Filtra por estado del usuario.', { enum: ['ACTIVE', 'SUSPENDED'] }),
        pageSize: int('Cuántos resultados devolver (1–100). Por defecto 20.', { minimum: 1, maximum: 100 }),
      }),
    },
    requiredPermission: 'users:read',
    method: 'GET',
    path: '/api/v1/users',
    queryParams: ['search', 'status', 'pageSize'],
    target: 'user',
  },
  {
    schema: {
      name: 'get_user',
      description: 'Devuelve el perfil completo de un usuario a partir de su identificador (UUID).',
      parameters: object({ userId: str('UUID del usuario.', { format: 'uuid' }) }, ['userId']),
    },
    requiredPermission: 'users:read',
    method: 'GET',
    path: '/api/v1/users/{userId}',
    queryParams: [],
    target: 'user',
  },
  {
    schema: {
      name: 'get_user_stats',
      description: 'Devuelve cuántos usuarios hay en total, cuántos activos, cuántos suspendidos y cuántos se crearon en los últimos 30 días.',
      parameters: object({}),
    },
    requiredPermission: 'users:read',
    method: 'GET',
    path: '/api/v1/users/stats',
    queryParams: [],
    target: 'user',
  },
  {
    schema: {
      name: 'list_roles',
      description: 'Lista los roles definidos en la plataforma con su descripción, sus permisos y cuántos usuarios los tienen asignados.',
      parameters: object({}),
    },
    requiredPermission: 'roles:read',
    method: 'GET',
    path: '/api/v1/roles',
    queryParams: [],
    target: 'role',
  },
  {
    schema: {
      name: 'get_user_roles',
      description: 'Devuelve los roles y permisos efectivos de un usuario concreto.',
      parameters: object({ userId: str('UUID del usuario.', { format: 'uuid' }) }, ['userId']),
    },
    requiredPermission: 'roles:read',
    method: 'GET',
    path: '/api/v1/user-roles/{userId}',
    queryParams: [],
    target: 'role',
  },
  {
    schema: {
      name: 'get_audit_events',
      description:
        'Consulta el registro de auditoría. Permite filtrar por tipo de evento (p. ej. auth.login_failed), por categoría, por autor y por rango de fechas ISO 8601. Útil para informes de accesos.',
      parameters: object({
        type: str('Tipo exacto del evento, con la forma contexto.evento (p. ej. auth.login_failed).'),
        category: str('Categoría del evento.', { enum: ['ACCESS', 'CHANGE', 'AI', 'OTHER'] }),
        actorId: str('UUID de quien originó el evento.'),
        from: str('Inicio del rango, en ISO 8601 (p. ej. 2026-11-01T00:00:00Z).'),
        to: str('Fin del rango, en ISO 8601.'),
        limit: int('Cuántos eventos devolver (1–100). Por defecto 20.', { minimum: 1, maximum: 100 }),
      }),
    },
    requiredPermission: 'audit:read',
    method: 'GET',
    path: '/api/v1/audit/events',
    queryParams: ['type', 'category', 'actorId', 'from', 'to', 'limit'],
    target: 'audit',
  },
  {
    schema: {
      name: 'get_audit_stats',
      description: 'Devuelve el total de eventos auditados, cuántos hubo en las últimas 24 horas y el desglose por categoría y por tipo.',
      parameters: object({}),
    },
    requiredPermission: 'audit:read',
    method: 'GET',
    path: '/api/v1/audit/stats',
    queryParams: [],
    target: 'audit',
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(TOOLS.map((t) => [t.schema.name, t]));

/** Las herramientas que este usuario puede usar, según los permisos que trae su token. */
export function toolsFor(permissions: readonly string[]): ToolDefinition[] {
  return TOOLS.filter((tool) => permissions.includes(tool.requiredPermission));
}
