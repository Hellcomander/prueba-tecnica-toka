import { Inject, Injectable } from '@nestjs/common';
import type { RateDecision, RateLimiter } from '../../domain/ports';
import { ENV, type Env } from '../config/env';
import { RedisService } from './redis.service';

/**
 * Límites propios, **por encima** de los del proveedor. Existen por tres razones distintas:
 *
 *  1. **Proteger la cuota compartida.** En el free tier el límite es por proyecto: un usuario
 *     entusiasta dejaría sin asistente a todos los demás. El límite por usuario reparte.
 *  2. **Degradar con información.** Un 429 propio sabe cuántos segundos faltan y puede decirlo;
 *     el del proveedor llega cuando ya se gastó la llamada.
 *  3. **Acotar el gasto.** El presupuesto diario de tokens por usuario es el único límite que
 *     mira el **costo** y no el número de peticiones: diez preguntas con informes largos cuestan
 *     más que cien preguntas de una línea.
 *
 * Las ventanas son fijas (minuto y día naturales), no deslizantes: `INCR` + `EXPIRE` es atómico,
 * cuesta dos comandos y se entiende de un vistazo. Una ventana deslizante sería más justa en la
 * frontera, pero aquí la frontera es un segundo cada minuto.
 *
 * Si Redis no responde, **se deja pasar** y se anota: el limitador protege la cuota, no la
 * seguridad, y convertir una avería de la caché en una caída del asistente sería desproporcionado.
 * Las decisiones de autorización no pasan por aquí.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async check(userId: string): Promise<RateDecision> {
    const minute = Math.floor(Date.now() / 60_000);
    const day = new Date().toISOString().slice(0, 10);
    try {
      const [globalRpm, userRpm, globalRpd, userTokens] = await Promise.all([
        this.bump(`agent:rl:global:m:${minute}`, 70),
        this.bump(`agent:rl:user:${userId}:m:${minute}`, 70),
        this.bump(`agent:rl:global:d:${day}`, 86_400),
        this.redis.get(`agent:rl:user:${userId}:tok:${day}`).then((v) => Number(v ?? 0)),
      ]);

      if (userRpm > this.env.AI_USER_RPM) return deny('user_rpm', secondsToNextMinute());
      if (globalRpm > this.env.AI_GLOBAL_RPM) return deny('global_rpm', secondsToNextMinute());
      if (userTokens >= this.env.AI_USER_DAILY_TOKENS) return deny('user_daily_tokens', secondsToMidnight());
      if (globalRpd > this.env.AI_GLOBAL_RPD) return deny('global_rpd', secondsToMidnight());
      return { allowed: true };
    } catch {
      return { allowed: true };
    }
  }

  async recordUsage(userId: string, tokens: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `agent:rl:user:${userId}:tok:${day}`;
    try {
      await this.redis.multi().incrby(key, tokens).expire(key, 86_400).exec();
    } catch {
      /* el gasto no se contabiliza; no vale tumbar una respuesta ya producida */
    }
  }

  private async bump(key: string, ttlSeconds: number): Promise<number> {
    const [[, count]] = (await this.redis.multi().incr(key).expire(key, ttlSeconds).exec()) as Array<[Error | null, number]>;
    return count;
  }
}

const deny = (scope: NonNullable<RateDecision['scope']>, retryAfterSeconds: number): RateDecision => ({ allowed: false, scope, retryAfterSeconds });

export const secondsToNextMinute = (now = Date.now()): number => 60 - Math.floor((now % 60_000) / 1_000);

export function secondsToMidnight(now = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((midnight - now.getTime()) / 1_000);
}
