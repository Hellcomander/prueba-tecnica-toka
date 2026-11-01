import { Injectable } from '@nestjs/common';
import type { AnswerCache } from '../../domain/ports';
import { RedisService } from './redis.service';

/**
 * Caché de respuestas. La clave la arma el caso de uso e incluye los permisos del usuario: dos
 * personas con permisos distintos recuperan pasajes distintos, así que compartir su respuesta
 * sería una fuga de autorización disfrazada de optimización.
 *
 * Un fallo de Redis degrada a "sin caché", nunca a un error: lo peor que puede pasar es pagar
 * una llamada al modelo que se podría haber ahorrado.
 */
@Injectable()
export class RedisAnswerCache implements AnswerCache {
  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch {
      /* sin caché se responde igual */
    }
  }
}
