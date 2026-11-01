import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { ProcessedEvents, UnitOfWork } from '../../application/ports';
import type { UserAccess } from '../../domain/access/user-access';
import type { DirectoryEntry } from '../../domain/directory/directory-entry';
import type { RoleRepository, UserAccessRepository, UserDirectoryRepository } from '../../domain/ports';
import type { Role } from '../../domain/role/role';
import { DomainError } from '../../domain/shared/domain-error';
import { Prisma } from '../../generated/prisma/client';
import { accessToDomain, directoryToDomain, roleToDomain, roleToRow } from './mappers';
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
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async findById(id: string): Promise<Role | null> {
    const row = await this.txHost.tx.role.findUnique({ where: { id } });
    return row ? roleToDomain(row) : null;
  }

  async findByName(name: string): Promise<Role | null> {
    const row = await this.txHost.tx.role.findUnique({ where: { name } });
    return row ? roleToDomain(row) : null;
  }

  async findByIds(ids: string[]): Promise<Role[]> {
    if (ids.length === 0) return [];
    return (await this.txHost.tx.role.findMany({ where: { id: { in: ids } } })).map(roleToDomain);
  }

  async list(): Promise<Role[]> {
    return (await this.txHost.tx.role.findMany({ orderBy: { name: 'asc' } })).map(roleToDomain);
  }

  async insert(role: Role): Promise<void> {
    try {
      await this.txHost.tx.role.create({ data: roleToRow(role) });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('ROLE_NAME_TAKEN', 'conflict', `Ya existe un rol llamado "${role.name}"`);
      throw e;
    }
  }

  async update(role: Role): Promise<void> {
    const { id, ...data } = roleToRow(role);
    try {
      // Bloqueo optimista: solo actualiza si nadie cambió la fila desde que se leyó.
      const result = await this.txHost.tx.role.updateMany({ where: { id, version: role.persistedVersion }, data });
      if (result.count === 0) throw versionConflict();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('ROLE_NAME_TAKEN', 'conflict', `Ya existe un rol llamado "${role.name}"`);
      throw e;
    }
  }

  async delete(role: Role): Promise<void> {
    await this.txHost.tx.role.delete({ where: { id: role.id } });
  }

  async memberIds(roleId: string): Promise<string[]> {
    return (await this.txHost.tx.userRole.findMany({ where: { roleId }, select: { userId: true } })).map((r) => r.userId);
  }

  async lockMembership(roleId: string): Promise<void> {
    await this.txHost.tx.$queryRaw`SELECT id FROM roles WHERE id = ${roleId}::uuid FOR UPDATE`;
  }
}

@Injectable()
export class PrismaUserAccessRepository implements UserAccessRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async get(userId: string): Promise<UserAccess> {
    const [row, roles] = await Promise.all([
      this.txHost.tx.userAccess.findUnique({ where: { userId } }),
      this.txHost.tx.userRole.findMany({ where: { userId }, select: { roleId: true } }),
    ]);
    return accessToDomain(userId, row, roles.map((r) => r.roleId));
  }

  async save(access: UserAccess, updatedBy: string | null): Promise<void> {
    const tx = this.txHost.tx;
    if (access.persistedVersion === 0) {
      try {
        await tx.userAccess.create({ data: { userId: access.userId, assignmentsVersion: access.version, updatedBy } });
      } catch (e) {
        if (isUniqueViolation(e)) throw versionConflict();
        throw e;
      }
    } else {
      const result = await tx.userAccess.updateMany({
        where: { userId: access.userId, assignmentsVersion: access.persistedVersion },
        data: { assignmentsVersion: access.version, updatedBy },
      });
      if (result.count === 0) throw versionConflict();
    }
    await tx.userRole.deleteMany({ where: { userId: access.userId, roleId: { notIn: access.roles } } });
    await tx.userRole.createMany({ data: access.roles.map((roleId) => ({ userId: access.userId, roleId })), skipDuplicates: true });
  }

  countActiveMembers(roleId: string, excludingUserId: string): Promise<number> {
    return this.txHost.tx.userRole.count({ where: { roleId, userId: { not: excludingUserId }, user: { status: 'ACTIVE' } } });
  }
}

@Injectable()
export class PrismaUserDirectoryRepository implements UserDirectoryRepository {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterPrisma<PrismaService>>) {}

  async find(userId: string): Promise<DirectoryEntry | null> {
    const row = await this.txHost.tx.userDirectory.findUnique({ where: { userId } });
    return row ? directoryToDomain(row) : null;
  }

  async ensureRegistered(entry: DirectoryEntry): Promise<void> {
    await this.txHost.tx.userDirectory.upsert({
      where: { userId: entry.userId },
      create: { userId: entry.userId, email: entry.email, status: entry.status, statusVersion: entry.statusVersion },
      update: {},
    });
  }

  async saveStatus(entry: DirectoryEntry): Promise<void> {
    await this.txHost.tx.userDirectory.update({
      where: { userId: entry.userId },
      data: { status: entry.status, statusVersion: entry.statusVersion },
    });
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
