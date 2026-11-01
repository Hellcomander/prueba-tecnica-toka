import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { ProcessedEvents, UnitOfWork } from '../../application/ports';
import type { ListUsersParams, UserReadModel, UserStats, UserView } from '../../application/queries/read-model';
import type { UserProfile } from '../../domain/profile/user-profile';
import { ADMIN_ROLE_NAME, type UserRolesProjection } from '../../domain/projection/user-roles-projection';
import type { UserProfileRepository, UserRolesProjectionRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { Prisma } from '../../generated/prisma/client';
import { profileToDomain, profileToRow, projectionToDomain, rowToView } from './mappers';
import type { PrismaService } from './prisma.service';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const versionConflict = () => new DomainError('VERSION_CONFLICT', 'conflict', 'El registro cambió mientras lo editabas; recarga e intenta de nuevo');

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
export class PrismaUserProfileRepository implements UserProfileRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async findById(id: string): Promise<UserProfile | null> {
    const row = await this.txHost.tx.userProfile.findUnique({ where: { id } });
    return row ? profileToDomain(row) : null;
  }

  async insertIfAbsent(profile: UserProfile): Promise<boolean> {
    // ON CONFLICT DO NOTHING cubre tanto el id como el email únicos.
    const { count } = await this.txHost.tx.userProfile.createMany({ data: profileToRow(profile), skipDuplicates: true });
    return count === 1;
  }

  async update(profile: UserProfile): Promise<void> {
    const { id, createdAt: _createdAt, ...data } = profileToRow(profile);
    // Bloqueo optimista: solo actualiza si nadie cambió la fila desde que se leyó.
    const result = await this.txHost.tx.userProfile.updateMany({ where: { id, version: profile.persistedVersion }, data });
    if (result.count === 0) throw versionConflict();
  }
}

@Injectable()
export class PrismaUserRolesProjectionRepository implements UserRolesProjectionRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async get(userId: string): Promise<UserRolesProjection> {
    return projectionToDomain(userId, await this.txHost.tx.userRolesView.findUnique({ where: { userId } }));
  }

  async save(projection: UserRolesProjection): Promise<void> {
    const tx = this.txHost.tx;
    if (projection.persistedVersion === 0) {
      try {
        await tx.userRolesView.create({ data: { userId: projection.userId, roles: projection.roles, assignmentsVersion: projection.version } });
      } catch (e) {
        if (isUniqueViolation(e)) throw versionConflict();
        throw e;
      }
      return;
    }
    const result = await tx.userRolesView.updateMany({
      where: { userId: projection.userId, assignmentsVersion: projection.persistedVersion },
      data: { roles: projection.roles, assignmentsVersion: projection.version },
    });
    if (result.count === 0) throw versionConflict();
  }

  async countActiveAdmins(excludingUserId: string): Promise<number> {
    const rows = await this.txHost.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM user_roles_view v
      JOIN user_profiles p ON p.id = v.user_id
      WHERE ${ADMIN_ROLE_NAME} = ANY (v.roles) AND p.status = 'ACTIVE' AND v.user_id <> ${excludingUserId}::uuid`;
    return rows[0]?.n ?? 0;
  }

  async lockAdminGuard(): Promise<void> {
    // Lock de transacción: se libera solo al confirmar o revertir. Se castea a text porque Prisma
    // no sabe deserializar el tipo `void` que devuelve pg_advisory_xact_lock.
    await this.txHost.tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('user-service:admin-guard'))::text`;
  }
}

@Injectable()
export class PrismaUserReadModel implements UserReadModel {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async list(params: ListUsersParams): Promise<{ items: UserView[]; total: number }> {
    const tx = this.txHost.tx;
    const search = params.search?.trim();
    const where: Prisma.UserProfileWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(search
        ? { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      tx.userProfile.findMany({ where, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], skip: (params.page - 1) * params.pageSize, take: params.pageSize }),
      tx.userProfile.count({ where }),
    ]);
    const roles = await this.rolesOf(rows.map((r) => r.id));
    return { items: rows.map((r) => rowToView(r, roles.get(r.id) ?? [])), total };
  }

  async get(id: string): Promise<UserView | null> {
    const row = await this.txHost.tx.userProfile.findUnique({ where: { id } });
    if (!row) return null;
    return rowToView(row, (await this.rolesOf([id])).get(id) ?? []);
  }

  async stats(): Promise<UserStats> {
    const tx = this.txHost.tx;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [byStatus, newLast7Days, byRole] = await Promise.all([
      tx.userProfile.groupBy({ by: ['status'], _count: { _all: true } }),
      tx.userProfile.count({ where: { createdAt: { gte: since } } }),
      tx.$queryRaw<{ role: string; count: number }[]>`
        SELECT r.role, count(*)::int AS count
        FROM user_roles_view v
        JOIN user_profiles p ON p.id = v.user_id AND p.status = 'ACTIVE'
        CROSS JOIN LATERAL unnest(v.roles) AS r(role)
        GROUP BY r.role
        ORDER BY r.role`,
    ]);
    const count = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0;
    return {
      total: byStatus.reduce((sum, g) => sum + g._count._all, 0),
      active: count('ACTIVE'),
      suspended: count('SUSPENDED'),
      activeAdmins: byRole.find((r) => r.role === ADMIN_ROLE_NAME)?.count ?? 0,
      byRole,
      newLast7Days,
    };
  }

  private async rolesOf(userIds: string[]): Promise<Map<string, string[]>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.txHost.tx.userRolesView.findMany({ where: { userId: { in: userIds } } });
    return new Map(rows.map((r) => [r.userId, r.roles]));
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
