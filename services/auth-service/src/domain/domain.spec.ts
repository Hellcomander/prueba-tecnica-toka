import { Account, Email, Password } from './account/account';
import { attemptKey, LOCK_THRESHOLD, lockDurationMs } from './security/lockout-policy';
import { decideRefresh, RefreshToken, Session } from './session/session';
import { DomainError, TooManyAttemptsError } from './shared/domain-error';
import { newOpaqueToken, sha256Hex } from './shared/hashing';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-03-01T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

describe('Email y Password', () => {
  it('el email se normaliza y rechaza formas inválidas', () => {
    expect(Email.of('  Admin@Toka.Local ').value).toBe('admin@toka.local');
    expect(code(() => Email.of('sin-arroba'))).toBe('INVALID_EMAIL');
    expect(code(() => Email.of('dos@@arrobas.com'))).toBe('INVALID_EMAIL');
    expect(code(() => Email.of(`${'a'.repeat(250)}@toka.local`))).toBe('INVALID_EMAIL');
  });

  it('la política de contraseña vive en el dominio, no en el DTO', () => {
    expect(Password.of('Admin123!demo').value).toBe('Admin123!demo');
    expect(code(() => Password.of('corta1'))).toBe('WEAK_PASSWORD');
    expect(code(() => Password.of('solo-letras-sin-numeros'))).toBe('WEAK_PASSWORD');
    expect(code(() => Password.of('1234567890'))).toBe('WEAK_PASSWORD');
    expect(code(() => Password.of(`Aa1${'x'.repeat(130)}`))).toBe('WEAK_PASSWORD');
  });
});

describe('Account', () => {
  const account = () => Account.register({ id: USER_ID, email: 'admin@toka.local', passwordHash: 'hash' });

  it('registrar deja la cuenta activa y emite AccountRegistered una sola vez', () => {
    const created = account();
    expect(created.isActive).toBe(true);
    expect(created.version).toBe(1);
    expect(created.pullDomainEvents()).toEqual([{ type: 'AccountRegistered', accountId: USER_ID, email: 'admin@toka.local' }]);
    expect(created.pullDomainEvents()).toEqual([]);
  });

  it('una cuenta suspendida no puede autenticarse', () => {
    const suspended = Account.restore({ id: USER_ID, email: 'a@toka.local', passwordHash: 'h', status: 'SUSPENDED', statusVersion: 1, version: 2 });
    expect(code(() => suspended.assertCanAuthenticate())).toBe('ACCOUNT_DISABLED');
    expect(code(() => account().assertCanAuthenticate())).toBe('ok');
  });

  it('applyStatus solo acepta versiones más nuevas y sube la versión de la fila una vez', () => {
    const restored = Account.restore({ id: USER_ID, email: 'a@toka.local', passwordHash: 'h', status: 'ACTIVE', statusVersion: 2, version: 5 });
    expect(restored.applyStatus('SUSPENDED', 2)).toBe(false);
    expect(restored.applyStatus('SUSPENDED', 1)).toBe(false);
    expect(restored.isActive).toBe(true);

    expect(restored.applyStatus('SUSPENDED', 3)).toBe(true);
    expect(restored.version).toBe(6);
    expect(restored.statusVersion).toBe(3);
    expect(restored.pullDomainEvents()).toEqual([{ type: 'AccountStatusChanged', accountId: USER_ID, status: 'SUSPENDED' }]);
  });
});

describe('Session y RefreshToken', () => {
  const session = () => Session.start({ id: SESSION_ID, userId: USER_ID, now: NOW, lifetimeMs: 60_000 });

  it('la sesión caduca por tope absoluto y la revocación es idempotente', () => {
    const s = session();
    expect(s.isActive(later(59_000))).toBe(true);
    expect(s.isActive(later(60_001))).toBe(false);

    expect(s.revoke('logout', NOW)).toBe(true);
    expect(s.revoke('refresh_reuse', later(1_000))).toBe(false);
    expect(s.revokedReason).toBe('logout');
    expect(s.isActive(NOW)).toBe(false);
  });

  it('el token opaco es aleatorio y en base solo vive su SHA-256', () => {
    const token = newOpaqueToken();
    expect(token).not.toBe(newOpaqueToken());
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(sha256Hex(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex(token)).not.toContain(token);
  });

  it('decideRefresh: token desconocido, vencido, de sesión revocada o reusado', () => {
    const s = session();
    const token = RefreshToken.issue({ tokenHash: 'a'.repeat(64), sessionId: SESSION_ID, now: NOW, lifetimeMs: 30_000 });

    expect(decideRefresh(null, NOW)).toEqual({ kind: 'reject', reason: 'unknown' });
    expect(decideRefresh({ session: s, token }, NOW)).toEqual({ kind: 'rotate' });
    expect(decideRefresh({ session: s, token }, later(30_001))).toEqual({ kind: 'reject', reason: 'token_expired' });

    const used = RefreshToken.restore({ tokenHash: 'a'.repeat(64), sessionId: SESSION_ID, expiresAt: later(30_000), usedAt: NOW });
    // Un token ya rotado es reúso incluso si además venció: esa señal manda, porque dispara la
    // revocación de la familia entera.
    expect(decideRefresh({ session: s, token: used }, later(99_000))).toEqual({ kind: 'reuse' });

    const revoked = session();
    revoked.revoke('logout', NOW);
    expect(decideRefresh({ session: revoked, token }, NOW)).toEqual({ kind: 'reject', reason: 'session_revoked' });

    const expiredSession = Session.start({ id: SESSION_ID, userId: USER_ID, now: NOW, lifetimeMs: 10_000 });
    const longToken = RefreshToken.issue({ tokenHash: 'b'.repeat(64), sessionId: SESSION_ID, now: NOW, lifetimeMs: 90_000 });
    expect(decideRefresh({ session: expiredSession, token: longToken }, later(11_000))).toEqual({ kind: 'reject', reason: 'session_expired' });
  });
});

describe('política de lockout', () => {
  it('no bloquea antes del umbral y luego duplica la espera hasta el tope de 30 min', () => {
    expect(lockDurationMs(1)).toBe(0);
    expect(lockDurationMs(LOCK_THRESHOLD - 1)).toBe(0);
    expect(lockDurationMs(LOCK_THRESHOLD)).toBe(60_000);
    expect(lockDurationMs(LOCK_THRESHOLD + 1)).toBe(120_000);
    expect(lockDurationMs(LOCK_THRESHOLD + 4)).toBe(16 * 60_000);
    expect(lockDurationMs(LOCK_THRESHOLD + 50)).toBe(30 * 60_000);
  });

  it('la llave combina email e IP: un tercero no puede bloquear a nadie solo sabiendo su correo', () => {
    const emailHash = sha256Hex('admin@toka.local');
    expect(attemptKey(emailHash, '10.0.0.1')).not.toBe(attemptKey(emailHash, '10.0.0.2'));
    expect(attemptKey(emailHash, null)).toBe(`${emailHash}:unknown`);
  });

  it('el error de lockout lleva el Retry-After y nunca degrada a un 500', () => {
    const error = new TooManyAttemptsError(42);
    expect(error.retryAfterSeconds).toBe(42);
    expect(error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(error.kind).toBe('forbidden');
  });
});
