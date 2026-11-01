import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../../domain/ports';

/**
 * argon2id con los parámetros que OWASP recomienda como mínimo (19 MiB, 2 iteraciones,
 * paralelismo 1). Es deliberadamente lento y usa memoria a propósito: encarece el crackeo
 * offline si alguien se lleva la tabla de cuentas. El hash resultante ya incluye sal y
 * parámetros, así que subirlos mañana no invalida los hashes de hoy.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Hash fijo para la verificación "dummy": se genera una vez al arrancar, con los mismos
 * parámetros, para que comparar contra una cuenta inexistente cueste lo mismo que contra una real.
 */
const DUMMY_PASSWORD = 'contrasena-que-nadie-usa-0000';

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash?: Promise<string>;

  hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  async verify(stored: string, plain: string): Promise<boolean> {
    try {
      return await verify(stored, plain, OPTIONS);
    } catch {
      // Hash corrupto o de otro algoritmo: es un fallo de credenciales, no un 500.
      return false;
    }
  }

  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash(DUMMY_PASSWORD);
    await this.verify(await this.dummyHash, plain);
  }
}
