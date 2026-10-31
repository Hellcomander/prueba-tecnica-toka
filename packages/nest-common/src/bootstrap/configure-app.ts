import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { correlationMiddleware } from '../context/request-context';

export interface ConfigureAppOptions {
  /** Saltos de proxy confiables (el gateway nginx = 1) para que req.ip sea la IP real del cliente. */
  trustProxyHops?: number;
}

/**
 * Configuración a nivel Express, común a todos los servicios. Se llama en main.ts (y en los
 * tests e2e) antes de app.listen()/app.init().
 */
export function configureApp(app: INestApplication, options: ConfigureAppOptions = {}): INestApplication {
  app.useLogger(app.get(Logger));
  app.use(correlationMiddleware);
  app.use(helmet());
  const express = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void; disable(key: string): void };
  express.set('trust proxy', options.trustProxyHops ?? 1);
  express.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
