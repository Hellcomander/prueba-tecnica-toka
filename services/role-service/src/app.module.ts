import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { AuthModule, CommonModule, HealthModule, MessagingModule } from '@toka/nest-common';
import { CreateRoleUseCase } from './application/commands/create-role.use-case';
import { DeleteRoleUseCase } from './application/commands/delete-role.use-case';
import { ReplaceUserRolesUseCase } from './application/commands/replace-user-roles.use-case';
import { SeedRolesUseCase } from './application/commands/seed-roles.use-case';
import { UpdateRoleUseCase } from './application/commands/update-role.use-case';
import { RoleEventHandlers } from './application/events/role-event-handlers';
import { EVENT_BUS, PROCESSED_EVENTS, UNIT_OF_WORK } from './application/ports';
import { GetAuthorizationQuery, GetRoleQuery, GetUserRolesQuery, ListPermissionsQuery, ListRolesQuery } from './application/queries/role-queries';
import { ROLE_REPOSITORY, USER_ACCESS_REPOSITORY, USER_DIRECTORY_REPOSITORY } from './domain/ports';
import { ENV, type Env } from './infrastructure/config/env';
import { AmqpEventBus } from './infrastructure/messaging/amqp-event-bus';
import { RoleBootstrap } from './infrastructure/messaging/role-bootstrap';
import {
  PrismaProcessedEvents,
  PrismaRoleRepository,
  PrismaUnitOfWork,
  PrismaUserAccessRepository,
  PrismaUserDirectoryRepository,
} from './infrastructure/persistence/prisma-repositories';
import { PrismaService } from './infrastructure/persistence/prisma.service';
import {
  InternalAuthorizationsController,
  PermissionsController,
  RolesController,
  UserRolesController,
} from './interface/http/role.controllers';

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
          service: 'role-service',
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
        HealthModule.forRoot({
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) => [{ name: 'postgres', check: () => prisma.$queryRaw`SELECT 1` }],
        }),
      ],
      controllers: [RolesController, PermissionsController, UserRolesController, InternalAuthorizationsController],
      providers: [
        { provide: ROLE_REPOSITORY, useClass: PrismaRoleRepository },
        { provide: USER_ACCESS_REPOSITORY, useClass: PrismaUserAccessRepository },
        { provide: USER_DIRECTORY_REPOSITORY, useClass: PrismaUserDirectoryRepository },
        { provide: PROCESSED_EVENTS, useClass: PrismaProcessedEvents },
        { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
        { provide: EVENT_BUS, useClass: AmqpEventBus },
        CreateRoleUseCase,
        UpdateRoleUseCase,
        DeleteRoleUseCase,
        ReplaceUserRolesUseCase,
        SeedRolesUseCase,
        RoleEventHandlers,
        ListRolesQuery,
        GetRoleQuery,
        ListPermissionsQuery,
        GetUserRolesQuery,
        GetAuthorizationQuery,
        RoleBootstrap,
      ],
    };
  }
}
