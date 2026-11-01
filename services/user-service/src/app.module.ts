import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { AuthModule, CommonModule, HealthModule, MessagingModule } from '@toka/nest-common';
import { ReactivateUserUseCase, SuspendUserUseCase } from './application/commands/change-status.use-case';
import { UpdateProfileUseCase } from './application/commands/update-profile.use-case';
import { UserEventHandlers } from './application/events/user-event-handlers';
import { EVENT_BUS, PROCESSED_EVENTS, STATS_CACHE, UNIT_OF_WORK } from './application/ports';
import { USER_READ_MODEL } from './application/queries/read-model';
import { GetUserQuery, GetUserStatsQuery, ListUsersQuery } from './application/queries/user-queries';
import { USER_PROFILE_REPOSITORY, USER_ROLES_PROJECTION_REPOSITORY } from './domain/ports';
import { RedisStatsCache } from './infrastructure/cache/redis-stats-cache';
import { ENV, type Env } from './infrastructure/config/env';
import { AmqpEventBus } from './infrastructure/messaging/amqp-event-bus';
import { UserBootstrap } from './infrastructure/messaging/user-bootstrap';
import {
  PrismaProcessedEvents,
  PrismaUnitOfWork,
  PrismaUserProfileRepository,
  PrismaUserReadModel,
  PrismaUserRolesProjectionRepository,
} from './infrastructure/persistence/prisma-repositories';
import { PrismaService } from './infrastructure/persistence/prisma.service';
import { UsersController } from './interface/http/user.controllers';

@Global()
@Module({})
class InfraModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: InfraModule,
      providers: [{ provide: ENV, useValue: env }, PrismaService],
      exports: [ENV, PrismaService],
    };
  }
}

/** Composition root: aquí, y solo aquí, se decide qué adaptador implementa cada puerto. */
@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(env),
        CommonModule.forRoot({
          service: 'user-service',
          level: env.LOG_LEVEL,
          clsPlugins: [
            new ClsPluginTransactional({
              imports: [InfraModule],
              adapter: new TransactionalAdapterPrisma({ prismaInjectionToken: PrismaService, sqlFlavor: 'postgresql' }),
            }),
          ],
        }),
        AuthModule.forRoot({ issuer: env.OIDC_ISSUER, jwksUri: env.JWKS_URI, audience: env.AUTH_AUDIENCE, securityEvents: 'publish' }),
        MessagingModule.forRoot({ url: env.RABBITMQ_URL }),
        // Readiness = solo el store primario. Redis es un acelerador que degrada a miss, no un requisito.
        HealthModule.forRoot({
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) => [{ name: 'postgres', check: () => prisma.$queryRaw`SELECT 1` }],
        }),
      ],
      controllers: [UsersController],
      providers: [
        { provide: USER_PROFILE_REPOSITORY, useClass: PrismaUserProfileRepository },
        { provide: USER_ROLES_PROJECTION_REPOSITORY, useClass: PrismaUserRolesProjectionRepository },
        { provide: USER_READ_MODEL, useClass: PrismaUserReadModel },
        { provide: PROCESSED_EVENTS, useClass: PrismaProcessedEvents },
        { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
        { provide: EVENT_BUS, useClass: AmqpEventBus },
        { provide: STATS_CACHE, useClass: RedisStatsCache },
        UpdateProfileUseCase,
        SuspendUserUseCase,
        ReactivateUserUseCase,
        UserEventHandlers,
        ListUsersQuery,
        GetUserQuery,
        GetUserStatsQuery,
        UserBootstrap,
      ],
    };
  }
}
