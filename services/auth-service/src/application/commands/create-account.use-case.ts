import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@toka/contracts';
import { Account, Password } from '../../domain/account/account';
import { ACCOUNT_REPOSITORY, type AccountRepository, PASSWORD_HASHER, type PasswordHasher } from '../../domain/ports';
import { accountRegistered, type AccountView, toAccountView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export interface CreateAccountInput {
  email: string;
  password: string;
  fullName: string;
  department?: string | null;
  jobTitle?: string | null;
}

/**
 * Alta de cuenta por un administrador. auth-service solo guarda credencial y estado; el perfil
 * (nombre, departamento, puesto) viaja en `account.registered` y lo materializa user-service.
 * El id lo genera auth y es el mismo `userId` en todo el sistema: no hay traducción de ids.
 */
@Injectable()
export class CreateAccountUseCase {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(input: CreateAccountInput, actor: Actor): Promise<AccountView> {
    const password = Password.of(input.password);
    const account = Account.register({
      id: randomUUID(),
      email: input.email,
      passwordHash: await this.hasher.hash(password.value),
    });
    await this.uow.run(() => this.accounts.insert(account));
    account.pullDomainEvents();
    await this.bus.publish([accountRegistered(account, input, 'admin', actor)]);
    return toAccountView(account);
  }
}
