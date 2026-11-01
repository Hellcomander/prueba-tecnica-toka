# Plantilla de servicio (referencia: `services/role-service`)

Cómo se construye un microservicio en este repo. role-service es la implementación de
referencia: ante la duda, se copia su estructura. El objetivo es que los cuatro servicios se
lean igual y que nadie reinvente capas.

## 1. Estructura

```
services/<svc>/
├─ prisma/schema.prisma, prisma/migrations/      (solo servicios con Postgres)
├─ prisma.config.ts
├─ Dockerfile
├─ src/
│  ├─ domain/                 TS puro
│  │  ├─ shared/domain-error.ts, aggregate-root.ts
│  │  ├─ <agregado>/<agregado>.ts     agregados, value objects, eventos de dominio
│  │  └─ ports.ts             interfaces de repositorio + tokens (Symbol)
│  ├─ application/
│  │  ├─ ports.ts             UnitOfWork, EventBus, ProcessedEvents + tokens
│  │  ├─ commands/*.use-case.ts       un caso de uso por clase
│  │  ├─ queries/*.ts         lado de lectura (sin transacción ni eventos)
│  │  ├─ events/*-handlers.ts consumidores de eventos (idempotentes)
│  │  └─ mappers/views.ts     dominio → vistas y → eventos de integración
│  ├─ infrastructure/
│  │  ├─ config/env.ts        schema zod de la configuración (falla al arrancar)
│  │  ├─ persistence/         PrismaService, *-repositories.ts, mappers.ts
│  │  └─ messaging/           adaptador EventBus y arranque (siembra + consumidores)
│  ├─ interface/http/         controllers delgados + dto/
│  ├─ app.module.ts           composition root
│  └─ main.ts
└─ test/
   ├─ fakes/in-memory.ts      repositorios en memoria con el mismo contrato
   └─ http.e2e.spec.ts        capa HTTP completa con tokens reales
```

## 2. Regla de dependencias (la verifica `npm run lint:arch`)

| Capa | Puede importar | No puede importar |
|---|---|---|
| `domain` | otros archivos de `domain`, `node:*` | Nest, Prisma, `@toka/*`, cualquier paquete npm |
| `application` | `domain`, `@toka/contracts`, `@nestjs/common` (DI), `@nestjs-cls/transactional` | `infrastructure`, `interface`, Prisma, amqp, Redis, axios, Express |
| `infrastructure` | todo lo anterior + Prisma, `@toka/nest-common` | otros servicios |
| `interface` | `application`, `@toka/nest-common` (decorators) | el cliente Prisma generado |

## 3. Imports con `isolatedModules` + `emitDecoratorMetadata` (importante)

Jest solo transpila, así que un error aquí pasa los tests y rompe el arranque o el build.

1. **Puertos (interfaces y tipos): `import type` + `@Inject(TOKEN)`.**
   `constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository)`
2. **Clases inyectadas por tipo: import de valor** (sin `type`), porque Nest lee el tipo de la
   metadata en runtime. `import { PrismaService } from './prisma.service'`. Con `import type`,
   la inyección falla al arrancar.
3. **Re-exports de tipos: `export type { … }`.**

`npm run test:cov` corre `tsc` antes de Jest para atrapar todo esto.

## 4. Dominio

- **Errores:** `DomainError(code, kind, message)`. `kind` ∈ `validation | not_found | conflict |
  forbidden | unprocessable` decide el status (400/404/409/403/422); `code` es lo que ve el
  cliente (`LAST_ADMIN`, `VERSION_CONFLICT`…). El filtro de nest-common lo reconoce por forma.
- **Agregados:** constructor privado, `static create()` (registra evento) y `static restore()`
  (desde base, sin eventos). Las invariantes se validan en el agregado, no en el controller.
- **Bloqueo optimista:** el agregado guarda `persistedVersion` (lo leído) y `version` (lo que se
  escribirá = persistida + 1 si hubo cambios). El repositorio hace
  `updateMany({ where: { id, version: persistedVersion } })` y, si `count === 0`, lanza
  `VERSION_CONFLICT`. Para requests del cliente, `assertVersion(dtoVersion)` antes de cambiar.
- **Eventos de dominio:** `record()` en el agregado; la aplicación los obtiene con
  `pullDomainEvents()` y los traduce a eventos de integración.
- **IDs:** UUID generados en la aplicación (`randomUUID()`), nunca por la base.

## 5. Aplicación

```ts
@Injectable()
export class CreateRoleUseCase {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
              @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
              @Inject(EVENT_BUS) private readonly bus: EventBus) {}

  async execute(input: CreateRoleInput, actor: Actor): Promise<RoleView> {
    const role = Role.create({ id: randomUUID(), ...input });
    await this.uow.run(async () => { /* validaciones con lecturas + escrituras */ });
    await this.bus.publish(role.pullDomainEvents().map((e) => roleEventToOutbound(e, actor))); // DESPUÉS del commit
    return toRoleView(role);
  }
}
```

- Escrituras dentro de `uow.run()`; **los eventos se publican después** del commit (nunca se
  anuncia algo que no se guardó). Si el broker falla, el adaptador registra el evento completo
  en el log (el outbox es un extra documentado).
- El `actor` (`{ id, type }`) viene del token en el controller, o `system` en consumidores.
- Las queries no abren transacción ni publican.

### Consumidores de eventos

- Validación del payload con `parseEvent(raw, [tipos esperados])` de `@toka/contracts`.
- **Idempotencia:** `processed.markProcessed(eventId)` en la **misma transacción** que el efecto;
  si devuelve `false`, el evento ya se aplicó y se ignora.
- **Orden:** si el evento trae `version`, aplicar solo si es más nueva que la guardada.
- Error transitorio (p. ej. "el usuario aún no existe") → lanzar un `Error` normal: la
  transacción se revierte y el mensaje vuelve en 5 s (3 intentos y luego DLQ). Error que
  reintentar no arregla → `NonRetryableError` (directo a la DLQ).
- Los consumidores se registran en `onApplicationBootstrap` (ver `role-bootstrap.ts`), sin
  bloquear el arranque HTTP y con reintento si el broker aún no está.

## 6. Infraestructura

- `PrismaService extends PrismaClient` con `new PrismaPg({ connectionString })` (Prisma 7 exige
  driver adapter).
- Repositorios con `TransactionHost<TransactionalAdapterPrisma<PrismaService>>` y `this.txHost.tx`
  (dentro de `uow.run` es el cliente transaccional). Mapear `P2002` (único) a un `DomainError`.
- `mappers.ts`: funciones puras fila ↔ dominio (sí se prueban).
- `AmqpEventBus`: usa `IntegrationEventFactory` (productor, correlationId, causationId) y
  `EVENT_PUBLISHER` de nest-common.

## 7. Interfaz HTTP

- Rutas versionadas: `@Controller('api/v1/<recurso>')`; internas: `internal/v1/...` con
  `@InternalRoute(SCOPES.X)`.
- **Cada ruta declara su permiso** con `@RequirePermissions(...)` (los guards globales niegan por
  defecto; `@Public()` es la excepción explícita).
- `ParseUUIDPipe` en todo `:id`. Registrar rutas fijas (`/me`, `/stats`) **antes** de `/:id`.
- DTOs con class-validator (whitelist + forbidNonWhitelisted ya están globales). Los
  controllers no tienen lógica: DTO → caso de uso → vista.

## 8. Composition root (`app.module.ts`) y `main.ts`

```ts
CommonModule.forRoot({ service, level, clsPlugins: [new ClsPluginTransactional({ imports: [InfraModule],
  adapter: new TransactionalAdapterPrisma({ prismaInjectionToken: PrismaService, sqlFlavor: 'postgresql' }) })] }),
AuthModule.forRoot({ issuer, jwksUri, audience, securityEvents: 'publish' }),
MessagingModule.forRoot({ url: env.RABBITMQ_URL }),         // declara toda la topología
HealthModule.forRoot({ inject: [PrismaService], useFactory: (p) => [{ name: 'postgres', check: () => p.$queryRaw`SELECT 1` }] }),
```

`main.ts`: `loadEnv()` → `NestFactory.create(AppModule.forRoot(env), { bufferLogs: true })` →
`configureApp(app, { trustProxyHops })` → `listen(PORT, '0.0.0.0')`.

## 9. Prisma

- `generator client { provider = "prisma-client"; output = "../src/generated/prisma"; moduleFormat = "cjs" }`.
- Tablas y columnas en snake_case con `@@map`/`@map`; `@db.Uuid` sin default; columna `version`;
  tabla `processed_events(event_id uuid pk)`.
- Migración nueva. El Postgres del compose no publica puertos; `docker-compose.dev.yml` es el
  override que lo expone en `127.0.0.1:15432` para poder correr el CLI desde el host:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres
  DATABASE_URL=postgresql://<svc>_svc:<pw>@127.0.0.1:15432/<svc>_db \
  SHADOW_DATABASE_URL=postgresql://<svc>_svc:<pw>@127.0.0.1:15432/<svc>_shadow \
  npx prisma migrate dev --name <cambio> -w services/<svc>
  ```
- En el contenedor, `prisma migrate deploy` corre antes de `node dist/main.js`.

## 10. Tests (gate 70% lines/statements/functions)

| Archivo | Qué prueba |
|---|---|
| `src/domain/domain.spec.ts` | Invariantes, value objects, versiones, eventos |
| `src/application/application.spec.ts` | Casos de uso y consumidores con `inMemoryContext()` (rollback incluido) |
| `test/http.e2e.spec.ts` | Controllers + DTOs + guards + errores, con `TestTokenFactory` (RS256 real) |
| `src/infrastructure/persistence/mappers.spec.ts`, `config/env.spec.ts` | Funciones puras |

Prohibido mockear Prisma, RabbitMQ o Redis: para eso están los fakes en memoria (mismo contrato)
y el smoke test contra el stack real.

## 11. Docker y compose

- `Dockerfile`: copiar el de role-service y cambiar `SVC`, `EXPOSE` y, si el servicio no usa
  Prisma, quitar `prisma/`, `prisma.config.ts` y el `migrate deploy` del `CMD`.
- compose: anclas `*node-svc` (no root, FS de solo lectura, sin capabilities, 256 MB) y
  `*node-env`; `depends_on` solo hacia su propia infraestructura con `service_healthy`;
  healthcheck `wget -qO- http://127.0.0.1:<puerto>/health/ready`.

## 12. Definición de terminado

- [ ] `npm run test:cov -w services/<svc>` en verde (incluye `tsc`).
- [ ] `npm run lint` y `npm run lint:arch` sin errores.
- [ ] `docker compose up -d --wait <svc>` → *healthy*.
- [ ] Cada ruta tiene `@RequirePermissions`, `@InternalRoute` o `@Public` a propósito.
- [ ] Los consumidores son idempotentes y respetan `version`.
- [ ] Los logs del servicio salen en JSON con `correlationId`.
