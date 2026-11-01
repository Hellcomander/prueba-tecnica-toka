import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { ProcessedEvents, UnitOfWork } from '../../application/ports';
import type { Account } from '../../domain/account/account';
import type { AccountRepository, SessionRepository } from '../../domain/ports';
import type { RefreshToken, RevocationReason, Session } from '../../domain/session/session';
import { DomainError } from '../../domain/shared/domain-error';
import { Prisma } from '../../generated/prisma/client';
import { accountToDomain, accountToRow, refreshTokenToDomain, sessionToDomain } from './mappers';
import type { PrismaService } from './prisma.service';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Los repositorios usan `txHost.tx`: dentro de UnitOfWork.run es el cliente transaccional, fuera
 * es el cliente normal. Los casos de uso no saben nada de esto.
 */
@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.txHost.withTransaction(work);
  }
}

@Injectable()
export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async findById(id: string): Promise<Account | null> {
    const row = await this.txHost.tx.account.findUnique({ where: { id } });
    return row ? accountToDomain(row) : null;
  }

  async findByEmail(email: string): Promise<Account | null> {
    const row = await this.txHost.tx.account.findUnique({ where: { email } });
    return row ? accountToDomain(row) : null;
  }

  async insert(account: Account): Promise<void> {
    try {
      await this.txHost.tx.account.create({ data: accountToRow(account) });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('EMAIL_TAKEN', 'conflict', 'Ya existe una cuenta con ese correo');
      throw e;
    }
  }

  async update(account: Account): Promise<void> {
    const { id, ...data } = accountToRow(account);
    // Bloqueo optimista: solo actualiza si nadie cambió la fila desde que se leyó.
    const result = await this.txHost.tx.account.updateMany({ where: { id, version: account.persistedVersion }, data });
    if (result.count === 0) {
      throw new DomainError('VERSION_CONFLICT', 'conflict', 'La cuenta cambió mientras la editabas; recarga e intenta de nuevo');
    }
  }
}

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async start(session: Session, token: RefreshToken): Promise<void> {
    await this.txHost.tx.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        revokedReason: session.revokedReason,
      },
    });
    await this.issue(token);
  }

  async findByTokenHash(tokenHash: string): Promise<{ session: Session; token: RefreshToken } | null> {
    const row = await this.txHost.tx.refreshToken.findUnique({ where: { tokenHash }, include: { session: true } });
    return row ? { session: sessionToDomain(row.session), token: refreshTokenToDomain(row) } : null;
  }

  /** UPDATE … WHERE used_at IS NULL: la carrera entre dos usos la resuelve la base. */
  async markUsed(tokenHash: string, now: Date): Promise<boolean> {
    const result = await this.txHost.tx.refreshToken.updateMany({ where: { tokenHash, usedAt: null }, data: { usedAt: now } });
    return result.count === 1;
  }

  async issue(token: RefreshToken): Promise<void> {
    await this.txHost.tx.refreshToken.create({
      data: { tokenHash: token.tokenHash, sessionId: token.sessionId, expiresAt: token.expiresAt, usedAt: token.usedAt },
    });
  }

  async revoke(session: Session): Promise<void> {
    await this.txHost.tx.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: session.revokedAt, revokedReason: session.revokedReason },
    });
  }

  async revokeAllForUser(userId: string, reason: RevocationReason, now: Date): Promise<string[]> {
    const open = await this.txHost.tx.session.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
    if (open.length === 0) return [];
    await this.txHost.tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
    return open.map((s) => s.id);
  }
}

@Injectable()
export class PrismaProcessedEvents implements ProcessedEvents {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async markProcessed(eventId: string, type: string): Promise<boolean> {
    const inserted = await this.txHost.tx.$executeRaw`
      INSERT INTO processed_events (event_id, type) VALUES (${eventId}::uuid, ${type})
      ON CONFLICT (event_id) DO NOTHING`;
    return inserted === 1;
  }
}
