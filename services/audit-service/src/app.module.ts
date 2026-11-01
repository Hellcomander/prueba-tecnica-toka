import { type DynamicModule, Global, Module } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { AuthModule, CommonModule, HealthModule, MessagingModule } from '@toka/nest-common';
import type { Connection } from 'mongoose';
import { GetAuditStatsQuery, ListAuditEventsQuery } from './application/audit-queries';
import { AUDIT_REPOSITORY } from './application/ports';
import { RecordAuditEventUseCase } from './application/record-audit-event.use-case';
import { ENV, type Env } from './infrastructure/config/env';
import { AuditBootstrap } from './infrastructure/messaging/audit-bootstrap';
import { AUDIT_MODEL, AuditEntrySchema, MongoAuditRepository } from './infrastructure/persistence/mongo-audit.repository';
import { AuditController } from './interface/http/audit.controller';

@Global()
@Module({})
class InfraModule {
  static forRoot(env: Env): DynamicModule {
    return { module: InfraModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
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
        CommonModule.forRoot({ service: 'audit-service', level: env.LOG_LEVEL }),
        // autoCreate/autoIndex en false: la colección y los índices los creó el script de init,
        // y el usuario `audit_svc` no tiene permiso para crearlos en caliente.
        MongooseModule.forRoot(env.MONGO_URL, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5_000 }),
        MongooseModule.forFeature([{ name: AUDIT_MODEL, schema: AuditEntrySchema }]),
        AuthModule.forRoot({ issuer: env.OIDC_ISSUER, jwksUri: env.JWKS_URI, audience: env.AUTH_AUDIENCE, securityEvents: 'publish' }),
        MessagingModule.forRoot({ url: env.RABBITMQ_URL }),
        HealthModule.forRoot({
          inject: [getConnectionToken()],
          // `ping` no requiere privilegios; ready solo valida el store primario.
          useFactory: (connection: Connection) => [{ name: 'mongo', check: () => connection.db!.admin().ping() }],
        }),
      ],
      controllers: [AuditController],
      providers: [
        { provide: AUDIT_REPOSITORY, useClass: MongoAuditRepository },
        RecordAuditEventUseCase,
        ListAuditEventsQuery,
        GetAuditStatsQuery,
        AuditBootstrap,
      ],
    };
  }
}
