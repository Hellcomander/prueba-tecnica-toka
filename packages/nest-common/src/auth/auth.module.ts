import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventPublishingSecurityEventSink } from '../messaging/messaging.module';
import { SECURITY_EVENT_SINK, type SecurityEventSink } from './auth.types';
import { JwtAuthGuard, PermissionsGuard } from './guards';
import { JWT_VERIFIER_OPTIONS, JwtVerifier, type JwtVerifierOptions } from './jwt-verifier';

export interface AuthModuleOptions extends JwtVerifierOptions {
  /**
   * Qué hacer con cada 403: 'publish' emite `access.denied` por RabbitMQ (requiere
   * MessagingModule), 'log' solo lo registra, o un sink propio (tests).
   */
  securityEvents?: 'publish' | 'log' | { useValue: SecurityEventSink };
}

/**
 * Registra los guards globales (APP_GUARD), así que todo servicio que importe este módulo queda
 * "deny by default" sin que cada controller tenga que acordarse de protegerse.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const { securityEvents = 'log', ...verifierOptions } = options;
    const providers: Provider[] = [
      { provide: JWT_VERIFIER_OPTIONS, useValue: verifierOptions },
      JwtVerifier,
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ];
    if (securityEvents === 'publish') {
      providers.push({ provide: SECURITY_EVENT_SINK, useClass: EventPublishingSecurityEventSink });
    } else if (typeof securityEvents === 'object') {
      providers.push({ provide: SECURITY_EVENT_SINK, useValue: securityEvents.useValue });
    }
    return { module: AuthModule, providers, exports: [JwtVerifier] };
  }
}
