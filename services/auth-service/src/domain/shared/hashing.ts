import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-256 en hexadecimal. Se usa para dos cosas distintas:
 *  - el `emailHash` de los eventos de seguridad (correlacionar intentos sin exponer la dirección);
 *  - el refresh token guardado en base (de la base solo se puede verificar, no reconstruir).
 * Un hash rápido es correcto aquí porque la entrada es de alta entropía (32 bytes aleatorios) o
 * no es un secreto (el email); las contraseñas, que sí son de baja entropía, van con argon2id.
 */
export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Refresh token opaco: 32 bytes de aleatoriedad criptográfica, sin estructura que adivinar. */
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');
