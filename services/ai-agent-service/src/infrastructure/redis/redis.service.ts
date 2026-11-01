import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

/** Conexión a Redis: límites de uso y caché de respuestas. Estado efímero, nunca fuente de verdad. */
@Injectable()
export class RedisService extends Redis implements OnApplicationShutdown {
  constructor(@Inject(ENV) env: Env) {
    super(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
    this.on('error', () => undefined); // ioredis reconecta solo; sin este handler el proceso cae
  }

  async onApplicationShutdown(): Promise<void> {
    await this.quit().catch(() => undefined);
  }
}
