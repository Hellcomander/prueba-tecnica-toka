import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { AuthModule, CommonModule, HealthModule, MessagingModule } from '@toka/nest-common';
import { CreateAccountUseCase } from './application/commands/create-account.use-case';
import { LoginUseCase } from './application/commands/login.use-case';
import { LogoutUseCase } from './application/commands/logout.use-case';
import { RefreshUseCase } from './application/commands/refresh.use-case';
import { SeedAccountsUseCase } from './application/commands/seed-accounts.use-case';
import { AuthEventHandlers } from './application/events/auth-event-handlers';
import {
  ATTEMPT_LIMITER,
  AUTH_SETTINGS,
  AUTHORIZATION_CACHE,
  AUTHORIZATION_PROVIDER,
  type AuthSettings,
  EVENT_BUS,
  KEY_SET_PROVIDER,
  PROCESSED_EVENTS,
  TOKEN_SIGNER,
  UNIT_OF_WORK,
} from './application/ports';
import { DiscoveryQuery, JwksQuery, UserInfoQuery } from './application/queries/auth-queries';
import { AuthorizationResolver } from './application/services/authorization-resolver';
import { ACCOUNT_REPOSITORY, PASSWORD_HASHER, SESSION_REPOSITORY } from './domain/ports';
import { RedisAttemptLimiter } from './infrastructure/cache/redis-attempt-limiter';
import { RedisAuthorizationCache } from './infrastructure/cache/redis-authorization-cache';
import { RedisService } from './infrastructure/cache/redis.service';
import { ENV, type Env } from './infrastructure/config/env';
import { RoleAuthorizationProvider } from './infrastructure/http/role-authorization-provider';
import { JoseTokenSigner } from './infrastructure/keys/jose-token-signer';
import { FileKeyStore } from './infrastructure/keys/key-store';
import { AmqpEventBus } from './infrastructure/messaging/amqp-event-bus';
import { AuthBootstrap } from './infrastructure/messaging/auth-bootstrap';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher';
import {
  PrismaAccountRepository,
  PrismaProcessedEvents,
  PrismaSessionRepository,
  PrismaUnitOfWork,
} from './infrastructure/persistence/prisma-repositories';
import { PrismaService } from './infrastructure/persistence/prisma.service';
import { AccountsController, AuthController, DiscoveryController } from './interface/http/auth.controllers';
import { COOKIE_SECURE } from './interface/http/cookies';

@Global()
@Module({})
class InfraModule {
  static forRoot(env: Env, keys: FileKeyStore): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: ENV, useValue: env }, { provide: FileKeyStore, useValue: keys }, PrismaService, RedisService],
      exports: [ENV, FileKeyStore, PrismaService, RedisService],
    };
  }
}

const settingsOf = (env: Env): AuthSettings => ({
  issuer: env.OIDC_ISSUER,
  accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  demoPasswords: { admin: env.SEED_ADMIN_PASSWORD, auditor: env.SEED_AUDITOR_PASSWORD, viewer: env.SEED_VIEWER_PASSWORD },
});

/** Composition root: aquí, y solo aquí, se decide qué adaptador implementa cada puerto. */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    // El key store se crea aquí (no por DI) porque AuthModule necesita su resolver de llaves al
    // definirse: auth valida sus propios tokens con la llave en memoria, sin pegarle por HTTP a
    // su propio JWKS. La carga del archivo sigue siendo diferida y compartida.
    const keys = new FileKeyStore(env.JWT_KEYS_DIR);
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(env, keys),
        CommonModule.forRoot({
          service: 'auth-service',
          level: env.LOG_LEVEL,
          clsPlugins: [
            new ClsPluginTransactional({
              imports: [InfraModule],
              adapter: new TransactionalAdapterPrisma({ prismaInjectionToken: PrismaService, sqlFlavor: 'postgresql' }),
            }),
          ],
        }),
        AuthModule.forRoot({
          issuer: env.OIDC_ISSUER,
          audience: env.AUTH_AUDIENCE,
          keyResolver: keys.verificationKeyResolver(),
          securityEvents: 'publish',
        }),
        MessagingModule.forRoot({ url: env.RABBITMQ_URL }),
        HealthModule.forRoot({
          inject: [PrismaService, RedisService],
          useFactory: (prisma: PrismaService, redis: RedisService) => [
            { name: 'postgres', check: () => prisma.$queryRaw`SELECT 1` },
            { name: 'redis', check: () => redis.ping() },
          ],
        }),
      ],
      controllers: [AuthController, AccountsController, DiscoveryController],
      providers: [
        { provide: AUTH_SETTINGS, useValue: settingsOf(env) },
        { provide: COOKIE_SECURE, useValue: env.COOKIE_SECURE },
        { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
        { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
        { provide: PROCESSED_EVENTS, useClass: PrismaProcessedEvents },
        { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
        { provide: EVENT_BUS, useClass: AmqpEventBus },
        { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
        { provide: TOKEN_SIGNER, useClass: JoseTokenSigner },
        { provide: KEY_SET_PROVIDER, useExisting: FileKeyStore },
        { provide: ATTEMPT_LIMITER, useClass: RedisAttemptLimiter },
        { provide: AUTHORIZATION_PROVIDER, useClass: RoleAuthorizationProvider },
        { provide: AUTHORIZATION_CACHE, useClass: RedisAuthorizationCache },
        AuthorizationResolver,
        LoginUseCase,
        RefreshUseCase,
        LogoutUseCase,
        CreateAccountUseCase,
        SeedAccountsUseCase,
        AuthEventHandlers,
        UserInfoQuery,
        DiscoveryQuery,
        JwksQuery,
        AuthBootstrap,
      ],
    };
  }
}
