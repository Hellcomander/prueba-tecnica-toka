import type { UserView } from '../../application/queries/read-model';
import { UserProfile, type UserStatus } from '../../domain/profile/user-profile';
import { UserRolesProjection } from '../../domain/projection/user-roles-projection';

/** Filas de Prisma ↔ dominio. Funciones puras: el dominio nunca ve tipos de Prisma. */
export interface ProfileRow {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  status: string;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const statusOf = (raw: string): UserStatus => (raw === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE');

export const profileToDomain = (row: ProfileRow): UserProfile => UserProfile.restore({ ...row, status: statusOf(row.status) });

export const profileToRow = (profile: UserProfile): ProfileRow => ({
  id: profile.id,
  email: profile.email,
  fullName: profile.fullName,
  department: profile.department,
  jobTitle: profile.jobTitle,
  status: profile.status,
  statusReason: profile.statusReason,
  version: profile.version,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

export const projectionToDomain = (userId: string, row: { roles: string[]; assignmentsVersion: number } | null): UserRolesProjection =>
  row ? UserRolesProjection.restore({ userId, roles: row.roles, assignmentsVersion: row.assignmentsVersion }) : UserRolesProjection.empty(userId);

/** Fila de perfil + roles de la proyección → vista de API. */
export const rowToView = (row: ProfileRow, roles: string[]): UserView => ({
  id: row.id,
  email: row.email,
  fullName: row.fullName,
  department: row.department,
  jobTitle: row.jobTitle,
  status: statusOf(row.status),
  statusReason: row.statusReason,
  roles: [...roles].sort(),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
