import { DEMO_USERS } from '@toka/contracts/seed';
import { SYSTEM_ROLES, type Permission } from '@toka/contracts/permissions';
import type { LoginInput, LoginResult } from './auth-api';

export async function loginDemo(input: LoginInput): Promise<LoginResult> {
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  const account = Object.values(DEMO_USERS).find((user) => user.email === input.email);
  if (!account || input.password.length < 8) {
    throw new Error('Correo o contraseña incorrectos.');
  }

  return {
    accessToken: `demo.${account.id}`,
    user: {
      id: account.id,
      email: account.email,
      fullName: account.fullName,
      roles: [account.role],
      permissions: [...SYSTEM_ROLES[account.role]] as Permission[],
    },
  };
}
