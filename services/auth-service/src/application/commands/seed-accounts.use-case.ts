import { Inject, Injectable } from '@nestjs/common';
import { DEMO_USERS } from '@toka/contracts';
import { Account, Password } from '../../domain/account/account';
import { ACCOUNT_REPOSITORY, type AccountRepository, PASSWORD_HASHER, type PasswordHasher } from '../../domain/ports';
import { accountRegistered } from '../mappers/views';
import { AUTH_SETTINGS, type AuthSettings, EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

/**
 * Siembra idempotente de las cuentas de demostración, con los ids fijos de @toka/contracts (los
 * mismos que usa role-service al asignarles su rol). Las contraseñas salen de la configuración,
 * nunca del código: en el repo solo viven los defaults de desarrollo del compose, y son datos
 * sintéticos. Publicar `account.registered` deja que user-service cree sus perfiles.
 */
@Injectable()
export class SeedAccountsUseCase {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async execute(options: { demoUsers: boolean }): Promise<{ createdAccounts: string[] }> {
    if (!options.demoUsers) return { createdAccounts: [] };
    const created: { account: Account; fullName: string }[] = [];
    for (const [role, user] of Object.entries(DEMO_USERS)) {
      if (await this.accounts.findById(user.id)) continue;
      const password = Password.of(this.settings.demoPasswords[role as keyof AuthSettings['demoPasswords']]);
      const account = Account.register({ id: user.id, email: user.email, passwordHash: await this.hasher.hash(password.value) });
      await this.uow.run(() => this.accounts.insert(account));
      account.pullDomainEvents();
      created.push({ account, fullName: user.fullName });
    }
    await this.bus.publish(created.map(({ account, fullName }) => accountRegistered(account, { fullName }, 'seed', { id: null, type: 'system' })));
    return { createdAccounts: created.map((c) => c.account.email) };
  }
}
