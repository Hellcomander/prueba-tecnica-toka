import { accountToDomain, accountToRow, refreshTokenToDomain, sessionToDomain } from './mappers';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('mappers de persistencia', () => {
  it('cuenta: fila → dominio → fila conserva todo y normaliza el estado desconocido a ACTIVE', () => {
    const row = { id: ACCOUNT_ID, email: 'Admin@Toka.local', passwordHash: '$argon2id$hash', status: 'SUSPENDED', statusVersion: 3, version: 2 };
    const account = accountToDomain(row);
    expect(account.email).toBe('admin@toka.local');
    expect(account.status).toBe('SUSPENDED');
    expect(account.isActive).toBe(false);
    expect(accountToRow(account)).toEqual({ ...row, email: 'admin@toka.local' });
    expect(accountToDomain({ ...row, status: 'lo-que-sea' }).status).toBe('ACTIVE');
  });

  it('sesión y refresh token: fechas y revocación viajan tal cual', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-02-01T00:00:00.000Z');
    const session = sessionToDomain({ id: SESSION_ID, userId: ACCOUNT_ID, createdAt, expiresAt, revokedAt: null, revokedReason: null });
    expect(session.isActive(createdAt)).toBe(true);
    expect(session.isActive(new Date('2026-03-01T00:00:00.000Z'))).toBe(false);

    const revoked = sessionToDomain({ id: SESSION_ID, userId: ACCOUNT_ID, createdAt, expiresAt, revokedAt: createdAt, revokedReason: 'logout' });
    expect(revoked.isRevoked).toBe(true);
    expect(revoked.revokedReason).toBe('logout');

    const token = refreshTokenToDomain({ tokenHash: 'a'.repeat(64), sessionId: SESSION_ID, expiresAt, usedAt: null });
    expect(token.isUsed).toBe(false);
    expect(token.isExpired(createdAt)).toBe(false);
    expect(refreshTokenToDomain({ tokenHash: 'b'.repeat(64), sessionId: SESSION_ID, expiresAt, usedAt: createdAt }).isUsed).toBe(true);
  });
});
