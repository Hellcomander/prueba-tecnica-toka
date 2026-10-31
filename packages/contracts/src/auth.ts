import type { Permission } from './permissions';

/** Audiencia de los access tokens de usuario (APIs públicas detrás del gateway). */
export const API_AUDIENCE = 'toka-api';
/** Audiencia de los tokens de servicio (rutas /internal/*, solo red interna). */
export const INTERNAL_AUDIENCE = 'toka-internal';
/** Tipo de JWT según RFC 9068 (JWT profile for OAuth 2.0 access tokens). */
export const ACCESS_TOKEN_TYP = 'at+jwt';

export const SCOPES = {
  /** auth → role: leer roles y permisos de un usuario para emitir su token (S1). */
  AUTHZ_READ: 'authz:read',
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export type TokenUse = 'access' | 'service';

export interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  sid: string;
  token_use: 'access';
  email: string;
  roles: string[];
  permissions: Permission[];
}

export interface ServiceTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  token_use: 'service';
  scope: string;
}

/** Respuesta de role-service a GET /internal/v1/authorizations/{userId} (S1). */
export interface UserAuthorization {
  userId: string;
  roles: string[];
  permissions: Permission[];
}
