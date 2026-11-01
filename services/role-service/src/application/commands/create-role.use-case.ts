import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Actor, isPermission } from '@toka/contracts';
import { ROLE_REPOSITORY, type RoleRepository } from '../../domain/ports';
import { Role } from '../../domain/role/role';
import { DomainError } from '../../domain/shared/domain-error';
import { roleEventToOutbound, type RoleView, toRoleView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: string[];
}

export function assertKnownPermissions(permissions: string[]): void {
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length > 0) {
    throw new DomainError('UNKNOWN_PERMISSION', 'unprocessable', `Permisos inexistentes: ${unknown.join(', ')}`);
  }
}

@Injectable()
export class CreateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(input: CreateRoleInput, actor: Actor): Promise<RoleView> {
    assertKnownPermissions(input.permissions);
    const role = Role.create({ id: randomUUID(), ...input });
    await this.uow.run(async () => {
      if (await this.roles.findByName(role.name)) {
        throw new DomainError('ROLE_NAME_TAKEN', 'conflict', `Ya existe un rol llamado "${role.name}"`);
      }
      await this.roles.insert(role);
    });
    await this.bus.publish(role.pullDomainEvents().map((e) => roleEventToOutbound(e, actor)));
    return toRoleView(role);
  }
}
