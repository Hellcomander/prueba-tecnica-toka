import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@toka/contracts';
import { ROLE_REPOSITORY, type RoleRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { roleEventToOutbound } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

@Injectable()
export class DeleteRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(roleId: string, actor: Actor): Promise<void> {
    const role = await this.uow.run(async () => {
      const role = await this.roles.findById(roleId);
      if (!role) throw new DomainError('ROLE_NOT_FOUND', 'not_found', 'El rol no existe');
      role.markDeleted((await this.roles.memberIds(role.id)).length);
      await this.roles.delete(role);
      return role;
    });
    await this.bus.publish(role.pullDomainEvents().map((e) => roleEventToOutbound(e, actor)));
  }
}
