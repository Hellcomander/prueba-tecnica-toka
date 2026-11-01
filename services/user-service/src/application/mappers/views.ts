import { type Actor, EVENTS } from '@toka/contracts';
import type { UserProfile, UserProfileEvent } from '../../domain/profile/user-profile';
import type { OutboundEvent } from '../ports';
import type { UserView } from '../queries/read-model';

export type { UserView };

export const toUserView = (profile: UserProfile, roles: string[]): UserView => ({
  id: profile.id,
  email: profile.email,
  fullName: profile.fullName,
  department: profile.department,
  jobTitle: profile.jobTitle,
  status: profile.status,
  statusReason: profile.statusReason,
  roles,
  version: profile.version,
  createdAt: profile.createdAt.toISOString(),
  updatedAt: profile.updatedAt.toISOString(),
});

/** Evento de dominio → evento de integración (el contrato de @toka/contracts). */
export function profileEventToOutbound(event: UserProfileEvent, actor: Actor): OutboundEvent {
  const subject = { type: 'user', id: event.userId };
  switch (event.type) {
    case 'ProfileUpdated':
      return {
        type: EVENTS.USER_PROFILE_UPDATED,
        subject,
        actor,
        data: { userId: event.userId, changedFields: event.changedFields, version: event.version },
      };
    case 'StatusChanged':
      return {
        type: EVENTS.USER_STATUS_CHANGED,
        subject,
        actor,
        data: { userId: event.userId, status: event.status, previousStatus: event.previousStatus, reason: event.reason, version: event.version },
      };
  }
}
