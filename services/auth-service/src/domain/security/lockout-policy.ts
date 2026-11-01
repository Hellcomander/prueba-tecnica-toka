/**
 * Política anti fuerza bruta. Vive en el dominio (pura, sin Redis) y el adaptador de Redis solo
 * cuenta y guarda lo que esta función decide.
 *
 * La llave es (hash del email, IP), no el email solo: si bastara el email, cualquiera podría
 * dejar fuera al admin desde su casa mandando contraseñas malas. Con la llave combinada, el
 * atacante solo se bloquea a sí mismo, y el usuario legítimo sigue entrando desde su IP.
 */
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCK_THRESHOLD = 5;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 30 * 60_000;

/** Backoff exponencial desde el 5º fallo: 1, 2, 4, 8, 16 y tope de 30 minutos. */
export function lockDurationMs(failures: number): number {
  if (failures < LOCK_THRESHOLD) return 0;
  return Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (failures - LOCK_THRESHOLD));
}

export const attemptKey = (emailHash: string, ip: string | null): string => `${emailHash}:${ip ?? 'unknown'}`;
