import { Controller, type DynamicModule, Get, Inject, Module, Res } from '@nestjs/common';
import { Public } from '../auth/decorators';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<unknown>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

const CHECK_TIMEOUT_MS = 2_000;

export interface HealthReport {
  status: 'ok' | 'down';
  checks: Record<string, 'up' | 'down'>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * live: el proceso responde (si falla, el orquestador lo reinicia).
 * ready: el store primario propio responde. A propósito no incluye a otros servicios ni al
 * broker: si un vecino cae, este servicio no debe salir de rotación en cascada.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: { status(code: number): unknown }): Promise<HealthReport> {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        try {
          await withTimeout(c.check(), CHECK_TIMEOUT_MS);
          return { name: c.name, up: true };
        } catch {
          return { name: c.name, up: false };
        }
      }),
    );
    const healthy = results.every((r) => r.up);
    if (!healthy) res.status(503);
    return {
      status: healthy ? 'ok' : 'down',
      checks: Object.fromEntries(results.map((r) => [r.name, r.up ? 'up' : 'down'])),
    };
  }
}

export interface HealthModuleOptions {
  /** Módulos que exportan las dependencias de los checks (p. ej. el módulo de Prisma). */
  imports?: DynamicModule['imports'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...deps: any[]) => ReadinessCheck[];
  inject?: unknown[];
}

@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKS, useFactory: options.useFactory, inject: (options.inject ?? []) as never[] }],
    };
  }
}
