import {
  ADMIN_ROLE,
  DEFAULT_ROLE,
  EVENTS,
  EventDataSchemas,
  InvalidEventError,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  QUEUES,
  SYSTEM_ROLES,
  createEnvelope,
  deadLetterQueueName,
  eventCategory,
  isKnownEventType,
  isPermission,
  parseEnvelope,
  parseEvent,
  retryQueueName,
} from './index';

const USER_ID = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';

const accountRegistered = () =>
  createEnvelope({
    type: EVENTS.ACCOUNT_REGISTERED,
    producer: 'auth-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: USER_ID },
    actor: { id: USER_ID, type: 'user' },
    data: { userId: USER_ID, email: 'ana@toka.test', fullName: 'Ana Pérez', source: 'admin' as const },
  });

describe('permisos y roles de sistema', () => {
  it('los roles de sistema solo usan permisos del catálogo', () => {
    for (const perms of Object.values(SYSTEM_ROLES)) {
      for (const p of perms) expect(PERMISSIONS).toContain(p);
    }
  });

  it('admin tiene todos los permisos y viewer es el rol por defecto sin escritura', () => {
    expect([...SYSTEM_ROLES[ADMIN_ROLE]].sort()).toEqual([...PERMISSIONS].sort());
    expect(DEFAULT_ROLE).toBe('viewer');
    expect((SYSTEM_ROLES.viewer as readonly string[]).some((p) => p.endsWith(':write') || p === 'roles:assign')).toBe(false);
  });

  it('cada permiso tiene descripción y isPermission distingue valores', () => {
    expect(Object.keys(PERMISSION_DESCRIPTIONS).sort()).toEqual([...PERMISSIONS].sort());
    expect(isPermission('audit:read')).toBe(true);
    expect(isPermission('audit:delete')).toBe(false);
  });
});

describe('envelope de eventos', () => {
  it('createEnvelope completa id, versión, fecha, causación y actor por defecto', () => {
    const env = createEnvelope({
      type: EVENTS.AUTH_LOGOUT,
      producer: 'auth-service',
      correlationId: 'corr-12345678',
      subject: { type: 'user', id: USER_ID },
      data: { userId: USER_ID, sid: 's1' },
    });
    expect(env.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.version).toBe(1);
    expect(new Date(env.occurredAt).toISOString()).toBe(env.occurredAt);
    expect(env.causationId).toBeNull();
    expect(env.actor).toEqual({ id: null, type: 'system' });
  });

  it('parseEnvelope acepta tipos desconocidos (audit registra todo) y conserva campos extra', () => {
    const raw = { ...accountRegistered(), type: 'billing.invoice_paid', extra: 1 };
    const env = parseEnvelope(raw) as unknown as Record<string, unknown>;
    expect(env.type).toBe('billing.invoice_paid');
    expect(env.extra).toBe(1);
  });

  it('parseEnvelope rechaza envelopes mal formados con un error descriptivo', () => {
    const bad = { ...accountRegistered(), eventId: 'no-es-uuid', type: 'SinPunto' };
    expect(() => parseEnvelope(bad)).toThrow(InvalidEventError);
    try {
      parseEnvelope(bad);
    } catch (e) {
      expect((e as InvalidEventError).issues).toContain('eventId');
      expect((e as InvalidEventError).issues).toContain('type');
    }
  });
});

describe('catálogo de eventos', () => {
  it('parseEvent valida el payload según el tipo', () => {
    const ev = parseEvent(accountRegistered(), [EVENTS.ACCOUNT_REGISTERED]);
    expect(ev.data.email).toBe('ana@toka.test');
  });

  it('parseEvent rechaza payload inválido, tipo desconocido y tipo no esperado', () => {
    const invalid = { ...accountRegistered(), data: { userId: USER_ID, email: 'no-email' } };
    expect(() => parseEvent(invalid)).toThrow(/Payload inválido/);
    expect(() => parseEvent({ ...accountRegistered(), type: 'billing.paid' })).toThrow(/desconocido/);
    expect(() => parseEvent(accountRegistered(), [EVENTS.USER_STATUS_CHANGED])).toThrow(/no esperado/);
  });

  it('todos los tipos del catálogo tienen schema', () => {
    for (const type of Object.values(EVENTS)) {
      expect(isKnownEventType(type)).toBe(true);
      expect(EventDataSchemas[type]).toBeDefined();
    }
    expect(isKnownEventType('nope.nope')).toBe(false);
  });

  it('user.status_changed exige versión para descartar eventos desordenados', () => {
    const base = { userId: USER_ID, status: 'SUSPENDED', previousStatus: 'ACTIVE' };
    expect(EventDataSchemas[EVENTS.USER_STATUS_CHANGED].safeParse(base).success).toBe(false);
    expect(EventDataSchemas[EVENTS.USER_STATUS_CHANGED].safeParse({ ...base, version: 2 }).success).toBe(true);
  });

  it('clasifica eventos en categorías de auditoría', () => {
    expect(eventCategory(EVENTS.AUTH_LOGIN_FAILED)).toBe('ACCESS');
    expect(eventCategory(EVENTS.ACCESS_DENIED)).toBe('ACCESS');
    expect(eventCategory(EVENTS.ACCOUNT_REGISTERED)).toBe('CHANGE');
    expect(eventCategory(EVENTS.ROLE_ASSIGNMENTS_CHANGED)).toBe('CHANGE');
    expect(eventCategory(EVENTS.AGENT_QUERY_COMPLETED)).toBe('AI');
    expect(eventCategory('billing.paid')).toBe('OTHER');
  });
});

describe('topología', () => {
  it('nombres de colas de reintento y DLQ', () => {
    expect(retryQueueName('user-service.events')).toBe('user-service.events.retry');
    expect(deadLetterQueueName('user-service.events')).toBe('user-service.events.dlq');
  });

  it('cada binding apunta a un evento del catálogo (o # para audit)', () => {
    const known = new Set<string>(Object.values(EVENTS));
    for (const q of Object.values(QUEUES)) {
      for (const b of q.bindings) expect(b === '#' || known.has(b)).toBe(true);
    }
  });
});
