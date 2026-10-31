import { z } from 'zod';
import { PERMISSIONS } from '../permissions';
import { EventEnvelopeSchema, type EventEnvelope } from './envelope';

/** Routing keys (= tipo de evento) publicadas en el exchange topic `toka.events`. */
export const EVENTS = {
  ACCOUNT_REGISTERED: 'account.registered',
  AUTH_LOGIN_SUCCEEDED: 'auth.login_succeeded',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_ACCOUNT_LOCKED: 'auth.account_locked',
  AUTH_LOGOUT: 'auth.logout',
  USER_PROFILE_UPDATED: 'user.profile_updated',
  USER_STATUS_CHANGED: 'user.status_changed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  ROLE_ASSIGNMENTS_CHANGED: 'role.assignments_changed',
  ACCESS_DENIED: 'access.denied',
  AGENT_QUERY_COMPLETED: 'agent.query_completed',
} as const;

export type EventType = (typeof EVENTS)[keyof typeof EVENTS];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const permission = z.enum(PERMISSIONS);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

// Los payloads nunca llevan secretos ni hashes de password: el email va hasheado en los eventos
// de seguridad para poder correlacionar intentos sin exponer la dirección.
export const EventDataSchemas = {
  [EVENTS.ACCOUNT_REGISTERED]: z.looseObject({
    userId: z.uuid(),
    email: z.email(),
    fullName: z.string().min(1).max(120),
    department: z.string().max(80).nullish(),
    jobTitle: z.string().max(80).nullish(),
    source: z.enum(['admin', 'seed']),
  }),
  [EVENTS.AUTH_LOGIN_SUCCEEDED]: z.looseObject({
    userId: z.uuid(),
    sid: z.string().min(1),
    emailHash: sha256Hex,
    ip: z.string().nullable(),
    userAgent: z.string().max(300).nullish(),
  }),
  [EVENTS.AUTH_LOGIN_FAILED]: z.looseObject({
    userId: z.uuid().nullable(),
    emailHash: sha256Hex,
    ip: z.string().nullable(),
    userAgent: z.string().max(300).nullish(),
    reason: z.enum(['invalid_credentials', 'account_disabled', 'locked']),
  }),
  [EVENTS.AUTH_ACCOUNT_LOCKED]: z.looseObject({
    emailHash: sha256Hex,
    ip: z.string().nullable(),
    lockedUntil: z.iso.datetime({ offset: true }),
  }),
  [EVENTS.AUTH_LOGOUT]: z.looseObject({
    userId: z.uuid(),
    sid: z.string().min(1),
  }),
  [EVENTS.USER_PROFILE_UPDATED]: z.looseObject({
    userId: z.uuid(),
    changedFields: z.array(z.string()).min(1),
    version: z.number().int().positive(),
  }),
  [EVENTS.USER_STATUS_CHANGED]: z.looseObject({
    userId: z.uuid(),
    status: z.enum(USER_STATUSES),
    previousStatus: z.enum(USER_STATUSES),
    reason: z.string().max(200).nullish(),
    // Versión del agregado UserProfile: los consumidores descartan eventos más viejos que
    // el último aplicado (RabbitMQ no garantiza orden entre reintentos).
    version: z.number().int().positive(),
  }),
  [EVENTS.ROLE_CREATED]: z.looseObject({
    roleId: z.uuid(),
    name: z.string().min(1),
    permissions: z.array(permission),
  }),
  [EVENTS.ROLE_UPDATED]: z.looseObject({
    roleId: z.uuid(),
    name: z.string().min(1),
    permissions: z.array(permission),
  }),
  [EVENTS.ROLE_DELETED]: z.looseObject({
    roleId: z.uuid(),
    name: z.string().min(1),
  }),
  // Snapshot completo de los roles del usuario (no un delta): un consumidor que se perdió
  // eventos queda consistente con el siguiente, y assignmentsVersion descarta los viejos.
  [EVENTS.ROLE_ASSIGNMENTS_CHANGED]: z.looseObject({
    userId: z.uuid(),
    roles: z.array(z.object({ id: z.uuid(), name: z.string().min(1) })),
    assignmentsVersion: z.number().int().positive(),
  }),
  [EVENTS.ACCESS_DENIED]: z.looseObject({
    userId: z.string().nullable(),
    method: z.string(),
    route: z.string(),
    required: z.array(z.string()),
    reason: z.enum(['missing_permission', 'wrong_token_use']),
  }),
  [EVENTS.AGENT_QUERY_COMPLETED]: z.looseObject({
    userId: z.uuid(),
    questionHash: sha256Hex,
    toolsUsed: z.array(z.string()),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    thinkingTokens: z.number().int().nonnegative(),
    embeddingTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    model: z.string(),
    mode: z.enum(['normal', 'fallback_model', 'rag_only']),
    cacheHit: z.boolean(),
    validationPassed: z.boolean(),
    flags: z.array(z.string()),
  }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventData<T extends EventType> = z.infer<(typeof EventDataSchemas)[T]>;
export type IntegrationEvent<T extends EventType = EventType> = EventEnvelope<T, EventData<T>>;

export class InvalidEventError extends Error {
  constructor(
    message: string,
    readonly issues: string,
  ) {
    super(message);
    this.name = 'InvalidEventError';
  }
}

export function isKnownEventType(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EventDataSchemas, type);
}

/** Valida solo el envelope. Lo usa audit, que registra cualquier evento, incluso tipos nuevos. */
export function parseEnvelope(raw: unknown): EventEnvelope {
  const result = EventEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidEventError('Envelope de evento inválido', z.prettifyError(result.error));
  }
  return result.data as EventEnvelope;
}

/** Valida envelope + payload según el catálogo. Lo usan los consumidores que actúan sobre el evento. */
export function parseEvent<T extends EventType>(raw: unknown, expected?: readonly T[]): IntegrationEvent<T> {
  const envelope = parseEnvelope(raw);
  if (!isKnownEventType(envelope.type)) {
    throw new InvalidEventError(`Tipo de evento desconocido: ${envelope.type}`, envelope.type);
  }
  if (expected && !(expected as readonly string[]).includes(envelope.type)) {
    throw new InvalidEventError(`Tipo de evento no esperado: ${envelope.type}`, envelope.type);
  }
  const data = EventDataSchemas[envelope.type].safeParse(envelope.data);
  if (!data.success) {
    throw new InvalidEventError(`Payload inválido para ${envelope.type}`, z.prettifyError(data.error));
  }
  return { ...envelope, data: data.data } as IntegrationEvent<T>;
}

export type AuditCategory = 'ACCESS' | 'CHANGE' | 'AI' | 'OTHER';

/** Categoría de auditoría: accesos (auth y denegaciones), cambios (cuentas, perfiles, roles) e IA. */
export function eventCategory(type: string): AuditCategory {
  if (type.startsWith('auth.') || type === EVENTS.ACCESS_DENIED) return 'ACCESS';
  if (type.startsWith('account.') || type.startsWith('user.') || type.startsWith('role.')) return 'CHANGE';
  if (type.startsWith('agent.')) return 'AI';
  return 'OTHER';
}
