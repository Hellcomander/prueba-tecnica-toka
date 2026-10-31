import type { Permission } from '@toka/contracts';

/** Usuario autenticado por un access token; lo deja JwtAuthGuard en `req.user`. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: string[];
  permissions: Permission[];
  sessionId: string;
  tokenUse: 'access';
}

/** Servicio autenticado por un token de servicio en una ruta /internal/*; queda en `req.principal`. */
export interface ServicePrincipal {
  id: string;
  scopes: string[];
  tokenUse: 'service';
}

export type AccessDeniedEvent = {
  userId: string | null;
  method: string;
  route: string;
  required: string[];
  reason: 'missing_permission' | 'wrong_token_use';
};

/** Puerto para reportar denegaciones de acceso (403) a la auditoría. */
export interface SecurityEventSink {
  accessDenied(event: AccessDeniedEvent): void | Promise<void>;
}

export const SECURITY_EVENT_SINK = Symbol('SECURITY_EVENT_SINK');
