import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { CORRELATION_HEADER } from '@toka/contracts';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { CLS_CORRELATION_ID } from './context/request-context';
import { ProblemDetailsFilter } from './errors/problem-details.filter';
import { buildPinoHttpOptions, type LoggerConfig } from './logging/logger-options';
import { SERVICE_NAME } from './messaging/event-publisher';
import { createValidationPipe } from './validation/validation.pipe';

export type CommonModuleOptions = LoggerConfig;

/**
 * Base de todo servicio: contexto por request (CLS) con el correlation-id, logs JSON con pino,
 * errores RFC 9457 y validación global de entrada. Se importa una vez en el AppModule.
 */
@Global()
@Module({})
export class CommonModule {
  static forRoot(options: CommonModuleOptions): DynamicModule {
    return {
      module: CommonModule,
      imports: [
        ClsModule.forRoot({
          global: true,
          middleware: {
            mount: true,
            generateId: true,
            // correlationMiddleware (configureApp) ya validó o generó el header.
            idGenerator: (req: { headers: Record<string, unknown> }) =>
              (req.headers[CORRELATION_HEADER] as string | undefined) ?? randomUUID(),
            setup: (cls) => cls.set(CLS_CORRELATION_ID, cls.getId()),
          },
        }),
        LoggerModule.forRoot({ pinoHttp: buildPinoHttpOptions(options) }),
      ],
      providers: [
        { provide: SERVICE_NAME, useValue: options.service },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
      exports: [SERVICE_NAME],
    };
  }
}
