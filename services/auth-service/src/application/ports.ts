import type { Actor, EventData, EventType, Permission, Subject, UserAuthorization } from '@toka/contracts';

/** Ejecuta `work` en una transacción: todo lo que hagan los repositorios adentro se confirma junto. */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface OutboundEvent<T extends EventType = EventType> {
  type: T;
  subject: Subject;
  data: EventData<T>;
  actor: Actor;
}

/** Publica eventos de integración. Se llama DESPUÉS del commit: nunca se anuncia algo que no se guardó. */
export interface EventBus {
  publish(events: OutboundEvent[]): Promise<void>;
}

/** Idempotencia de consumidores: false si el evento ya se procesó (at-least-once). */
export interface ProcessedEvents {
  markProcessed(eventId: string, type: string): Promise<boolean>;
}

export interface AccessTokenRequest {
  userId: string;
  email: string;
  sessionId: string;
  roles: string[];
  permissions: Permission[];
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresInSeconds: number;
}

/** Firma de JWT (RS256). La llave y su rotación son asunto de infraestructura. */
export interface TokenSigner {
  signAccessToken(request: AccessTokenRequest): Promise<SignedAccessToken>;
  /** Token de servicio de vida corta para llamar a otro servicio por la red interna (S1). */
  signServiceToken(scope: string): Promise<string>;
}

/** Documento JWKS público (solo la parte pública de la llave). */
export interface KeySetProvider {
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}

export interface AttemptStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

export interface AttemptFailure {
  failures: number;
  lockedUntil: Date | null;
}

/** Contador de intentos fallidos por (email, IP). En producción es Redis; en tests, memoria. */
export interface AttemptLimiter {
  status(key: string): Promise<AttemptStatus>;
  registerFailure(key: string): Promise<AttemptFailure>;
  reset(key: string): Promise<void>;
}

/** S1: roles y permisos efectivos del usuario, que viven en role-service. */
export interface AuthorizationProvider {
  fetch(userId: string): Promise<UserAuthorization>;
}

/** Copia "stale" de la última autorización conocida (Redis, TTL corto). */
export interface AuthorizationCache {
  find(userId: string): Promise<UserAuthorization | null>;
  save(authorization: UserAuthorization): Promise<void>;
}

/** Configuración de emisión de tokens. Se arma en el composition root a partir del entorno. */
export interface AuthSettings {
  issuer: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionTtlSeconds: number;
  demoPasswords: Record<'admin' | 'auditor' | 'viewer', string>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const EVENT_BUS = Symbol('EVENT_BUS');
export const PROCESSED_EVENTS = Symbol('PROCESSED_EVENTS');
export const TOKEN_SIGNER = Symbol('TOKEN_SIGNER');
export const KEY_SET_PROVIDER = Symbol('KEY_SET_PROVIDER');
export const ATTEMPT_LIMITER = Symbol('ATTEMPT_LIMITER');
export const AUTHORIZATION_PROVIDER = Symbol('AUTHORIZATION_PROVIDER');
export const AUTHORIZATION_CACHE = Symbol('AUTHORIZATION_CACHE');
export const AUTH_SETTINGS = Symbol('AUTH_SETTINGS');
