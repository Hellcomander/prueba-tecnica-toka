import { Account, type AccountStatus } from '../../domain/account/account';
import { RefreshToken, type RevocationReason, Session } from '../../domain/session/session';

/** Filas de Prisma ↔ dominio. Funciones puras: el dominio nunca ve tipos de Prisma. */
export interface AccountRow {
  id: string;
  email: string;
  passwordHash: string;
  status: string;
  statusVersion: number;
  version: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface RefreshTokenRow {
  tokenHash: string;
  sessionId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const toStatus = (value: string): AccountStatus => (value === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE');

export const accountToDomain = (row: AccountRow): Account =>
  Account.restore({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    status: toStatus(row.status),
    statusVersion: row.statusVersion,
    version: row.version,
  });

export const accountToRow = (account: Account): AccountRow => ({
  id: account.id,
  email: account.email,
  passwordHash: account.passwordHash,
  status: account.status,
  statusVersion: account.statusVersion,
  version: account.version,
});

export const sessionToDomain = (row: SessionRow): Session =>
  Session.restore({
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: (row.revokedReason as RevocationReason | null) ?? null,
  });

export const refreshTokenToDomain = (row: RefreshTokenRow): RefreshToken =>
  RefreshToken.restore({ tokenHash: row.tokenHash, sessionId: row.sessionId, expiresAt: row.expiresAt, usedAt: row.usedAt });
