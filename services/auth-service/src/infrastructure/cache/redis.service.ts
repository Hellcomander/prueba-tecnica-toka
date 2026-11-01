import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

/**
 * Conexión a Redis. Redis aquí es estado efímero (contadores de intentos y copia stale de
 * autorizaciones): si se cae, el servicio sigue de pie; lo único que se pierde es el backoff
 * acumulado y la red de seguridad de S1.
 */
@Injectable()
export class RedisService extends Redis implements OnApplicationShutdown {
  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.quit().catch(() => undefined);
  }
}
