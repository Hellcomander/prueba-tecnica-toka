# DDD + Clean Architecture: cómo se aplican aquí

> `docs/architecture.md` explica **el sistema**; `docs/service-template.md` explica **cómo se
> construye un servicio nuevo**. Este documento explica **por qué el código tiene esta forma**:
> qué parte de DDD se usó, dónde se usó a propósito menos, y cómo la regla de dependencias deja
> de ser una convención para volverse algo que falla en CI.

Todo el código citado está en el repositorio, con su ruta. No hay pseudocódigo.

---

## 1. Las dos decisiones no son la misma decisión

Se mezclan seguido, así que conviene separarlas:

| | Qué resuelve | Qué sería un fracaso |
|---|---|---|
| **DDD** | Dónde vive cada concepto del negocio y cómo se llama | Un `UserService` de 900 líneas que lo sabe todo; reglas de negocio repartidas entre controllers y SQL |
| **Clean Architecture** | En qué dirección apuntan las dependencias | Un dominio que no se puede probar sin levantar Postgres; cambiar de ORM obliga a tocar las reglas |

DDD responde *qué* modelar; Clean Architecture responde *hacia dónde apuntan las flechas*. Se
pueden tener las dos, una, o ninguna. Aquí se usan las dos, pero **en dosis distintas según el
subdominio** (§3), porque aplicar DDD táctico completo a un read model solo agrega ceremonia.

---

## 2. DDD estratégico: los bounded contexts y el mapa entre ellos

Los cuatro servicios **no** son una partición técnica por capas (nada de "servicio de base de
datos" o "servicio de API"): cada uno es un **bounded context** con su propio lenguaje.

La prueba de que la frontera está bien puesta es que **la misma palabra significa cosas
distintas de cada lado, y eso no es un error**:

| Palabra | En `auth` | En `user` | En `role` | En `audit` |
|---|---|---|---|---|
| **usuario** | `Account`: email, hash argon2id, estado de bloqueo | `UserProfile`: nombre, área, puesto, estado | `UserAccess` + `DirectoryEntry`: a qué roles pertenece y si está activo | una cadena en `actor.id` dentro de un evento inmutable |
| **suspender** | dejar de emitir y de refrescar tokens | la operación de negocio, con su regla y su evento | marcar `status` en el directorio local | una fila más |

Si hubiera un solo modelo `User` compartido, la primera funcionalidad que necesitara un campo
"solo para auth" lo metería en una clase que `audit` también importa. Ese es el acoplamiento que
los bounded contexts evitan — y por eso `no-cross-service-imports` es una regla de CI (§5).

### Mapa de contextos

| Relación | Patrón DDD | Dónde está |
|---|---|---|
| `auth` → `user`, `role`, `audit` | **Publisher/Subscriber** sobre lenguaje publicado | `account.registered` crea el perfil y asigna el rol por defecto |
| `role` → `user` | **Customer/Supplier**: `user` depende del snapshot de asignaciones | `role.assignments_changed` → `user_roles_view` |
| `user` → `auth`, `role` | Publisher/Subscriber | `user.status_changed` bloquea el login y actualiza `user_directory` |
| `auth` → `role` (S1) | **Conformist** síncrono: `auth` consume el modelo de `role` tal cual | `services/auth-service/src/infrastructure/http/role-authorization-provider.ts` |
| Todos → `@toka/contracts` | **Lenguaje publicado** (*published language*) | `packages/contracts/src/events/catalog.ts`, `permissions.ts` |

**`@toka/contracts` es el lenguaje publicado, no un modelo de dominio compartido.** Contiene
esquemas zod de eventos, el catálogo de permisos y la topología AMQP: el *contrato*, no las
*reglas*. Ningún agregado vive ahí. Es la diferencia entre acordar un idioma y compartir un
cerebro.

### El lenguaje ubicuo llega hasta los códigos de error

`LAST_ADMIN`, `SELF_ADMIN_REMOVAL`, `SYSTEM_ROLE_IMMUTABLE`, `ROLE_IN_USE`, `VERSION_CONFLICT`.
Son términos del negocio y viajan sin traducirse: el agregado los lanza, el filtro de errores los
convierte en `problem+json` y la SPA los usa para decidir el mensaje. Cuando alguien en una
reunión dice "el caso del último admin", existe una constante con ese nombre.

---

## 3. DDD táctico, en dosis graduadas

Una decisión explícita, no un descuido: **el esfuerzo de modelado se gasta donde hay reglas.**

| Servicio | Tipo de subdominio | Qué se usa | Por qué |
|---|---|---|---|
| `role` | **Núcleo** | Agregados (`Role`, `UserAccess`), value object (`RoleName`), eventos de dominio, invariantes que cruzan contextos | Aquí viven las reglas más caras de equivocarse |
| `auth` | **Núcleo** | Agregados (`Account`, `Session`), política de dominio (`LockoutPolicy`), hashing como puerto | Seguridad: cada regla debe ser probable sin red |
| `user` | Soporte con reglas | Agregado ligero (`UserProfile`) + proyección (`UserRolesProjection`) | Tiene una invariante real (último admin) pero poco más |
| `audit` | **Soporte / genérico** | **Sin carpeta `domain/`**: caso de uso + repositorio + queries | Es un read model append-only. No tiene invariantes, no tiene ciclo de vida, no cambia de estado. Un `AuditEntry` con constructor privado y `pullDomainEvents()` sería ceremonia pura |

Que `services/audit-service/src/` no tenga `domain/` es intencional y defendible: **DDD táctico
donde no hay comportamiento es sobrecoste sin beneficio.** Lo que sí conserva son las capas
(`application`, `infrastructure`, `interface`) y la regla de dependencias.

### Agregados: la invariante vive adentro, no en el controller

`services/role-service/src/domain/access/user-access.ts` — la regla del último administrador:

```ts
replaceRoles(newRoleIds: string[], guard: AdminGuardContext): boolean {
  const next = new Set(newRoleIds);
  const unchanged = next.size === this.roleIds.size && [...next].every((id) => this.roleIds.has(id));
  if (unchanged) return false;

  const losesAdmin = this.roleIds.has(guard.adminRoleId) && !next.has(guard.adminRoleId);
  if (losesAdmin && guard.actorId === this.userId) {
    throw new DomainError('SELF_ADMIN_REMOVAL', 'conflict', 'No puedes quitarte a ti mismo el rol admin');
  }
  if (losesAdmin && guard.userIsActive && guard.otherActiveAdmins === 0) {
    throw new DomainError('LAST_ADMIN', 'conflict', 'No se puede quitar el rol admin al último administrador activo');
  }
  this.apply(next);
  return true;
}
```

Tres detalles que explican el diseño:

1. **El agregado no consulta la base.** Recibe `AdminGuardContext` con los hechos ya reunidos
   (`otherActiveAdmins`, `userIsActive`). Así la regla se prueba con un objeto literal, sin
   mocks, sin Docker — y la decisión de *cómo* contar admins (una query, un lock) queda en la
   aplicación, que es donde pertenece.
2. **Devuelve `boolean`, no `void`.** `false` significa "nada cambió", y el caso de uso lo usa
   para **no publicar un evento de integración** por una petición que no modificó nada. Evitar
   eventos espurios es barato aquí y caro más tarde, cuando cuatro consumidores reaccionan a
   nada.
3. **Lanza `DomainError`, no `ConflictException` de Nest.** El dominio no conoce HTTP. El `kind`
   (`conflict`) es lo que el filtro de `@toka/nest-common` traduce a 409.

### Value objects: validar una vez, en el borde del modelo

`RoleName` (`domain/role/role.ts`) tiene constructor privado y una única fábrica `of()`. Una vez
que existe un `RoleName`, **es válido por construcción**: ningún punto del código necesita volver
a preguntarse si el nombre trae espacios o mayúsculas.

### Bloqueo optimista como parte del modelo, no del ORM

Cada agregado guarda `persistedVersion` (lo que se leyó) y `version` (lo que se escribirá). El
repositorio hace `updateMany({ where: { id, version: persistedVersion } })` y, si `count === 0`,
lanza `VERSION_CONFLICT`. El cliente puede además mandar la versión que vio, y el agregado la
compara con `assertVersion()`. La concurrencia se expresa **en el lenguaje del dominio** ("el rol
cambió desde que lo leíste"), no como un error del ORM que se filtra hasta la UI.

### Eventos de dominio ≠ eventos de integración

Son dos cosas distintas y el código las mantiene separadas:

- **Evento de dominio**: `{ type: 'UserRolesChanged', userId, roleIds, assignmentsVersion }`.
  Interno, con el vocabulario del agregado, sin envelope. Se registra con `record()`.
- **Evento de integración**: `role.assignments_changed` con el envelope versionado de
  `@toka/contracts` (`eventId, type, version, occurredAt, producer, correlationId, actor,
  subject, data`). Es lo que otros contextos ven, y es un contrato público.

La traducción es explícita y vive en un solo lugar: `application/mappers/views.ts`. Gracias a eso
se puede renombrar un campo interno sin romper a nadie, y cambiar el contrato público es una
decisión visible en el diff.

---

## 4. Clean Architecture: cuatro capas y una sola dirección

```
interface/http  →  application  →  domain  ←  infrastructure
   (entra)          (orquesta)      (sabe)      (implementa los puertos)
```

Las flechas apuntan **hacia adentro**. `infrastructure` apunta al dominio porque implementa sus
interfaces: ese es el giro de dependencias (*dependency inversion*) y es lo que hace que Prisma
sea un detalle reemplazable en vez de la columna vertebral del sistema.

| Capa | Qué hay | Qué tiene prohibido |
|---|---|---|
| `domain/` | Agregados, value objects, eventos de dominio, `DomainError`, **puertos de repositorio** | Nest, Prisma, `@toka/*`, cualquier paquete npm |
| `application/` | Un caso de uso por clase, queries, handlers de eventos, mappers a vistas | `infrastructure`, `interface`, Prisma, amqp, Redis, axios, Express |
| `infrastructure/` | Repositorios Prisma/Mongo, `AmqpEventBus`, Redis, config zod, clientes HTTP | Código de otro servicio |
| `interface/http/` | Controllers delgados, DTOs, health | El cliente Prisma generado |

### El puerto lo define quien lo necesita

`services/role-service/src/domain/ports.ts` — el dominio declara **qué** necesita; nunca **cómo**:

```ts
export interface UserAccessRepository {
  get(userId: string): Promise<UserAccess>;
  save(access: UserAccess, updatedBy: string | null): Promise<void>;
  countActiveMembers(roleId: string, excludingUserId: string): Promise<number>;
}

export const USER_ACCESS_REPOSITORY = Symbol('USER_ACCESS_REPOSITORY');
```

El `Symbol` existe porque en TypeScript una interfaz **no sobrevive a la compilación**: no hay
tipo en runtime que Nest pueda usar como token de inyección. De ahí el patrón que se repite en
todo el repo: `import type` para el puerto (desaparece al compilar) + `@Inject(TOKEN)` para
resolverlo. Hacerlo al revés —`import` de valor sobre una interfaz— compila, pasa los tests y
**revienta al arrancar el contenedor**, porque Jest solo transpila
(`docs/service-template.md` §3).

### El caso de uso: orquestar, no decidir

`application/commands/replace-user-roles.use-case.ts` muestra el reparto completo de
responsabilidades:

```ts
const { view, changed } = await this.uow.run(async () => {
  const entry = await this.directory.find(userId);
  if (!entry) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
  // … valida que los roles existan …

  // Serializa con cualquier otra transacción que cambie admins: sin esto, dos admins que se
  // quitan el rol mutuamente al mismo tiempo pasarían ambos el conteo.
  await this.roles.lockMembership(SYSTEM_ROLE_IDS.admin);
  const userAccess = await this.access.get(userId);
  if (input.assignmentsVersion !== undefined) userAccess.assertVersion(input.assignmentsVersion);
  const changed = userAccess.replaceRoles(roleIds, {
    adminRoleId: SYSTEM_ROLE_IDS.admin,
    actorId: actor.id,
    userIsActive: entry.isActive,
    otherActiveAdmins: await this.access.countActiveMembers(SYSTEM_ROLE_IDS.admin, userId),
  });
  if (changed) await this.access.save(userAccess, actor.id);
  return { view: toUserRolesView(userAccess, roles), changed };
});

if (changed) await this.bus.publish([assignmentsChanged(view, actor)]);
```

El caso de uso **reúne hechos, abre la transacción, toma el lock y publica**. La **decisión** —si
esto se permite o no— es una sola línea dentro del agregado. Nótese además:

- **`lockMembership` está en el caso de uso, no en el agregado.** Es una decisión de
  concurrencia, no una regla de negocio: el agregado no debe saber que existe
  `SELECT … FOR UPDATE`. Es la contraparte honesta del límite documentado en
  `docs/architecture.md` §4: dentro de `role` la invariante se serializa de verdad; **entre**
  `role` y `user` la ventana de consistencia eventual sigue existiendo y está documentada, no
  disimulada.
- **`this.bus.publish(...)` está fuera de `uow.run`.** Se publica **después** del commit: nunca
  se anuncia algo que no se guardó. El precio es el caso contrario —commit exitoso y broker
  caído—, que el adaptador registra en el log con el evento completo y que el patrón *outbox*
  resolvería; está declarado como siguiente paso en el README y como acción A1 de
  `docs/ejercicio-4-diagnostico.md`. Se prefiere "puede faltar un evento, y se ve en el log" a
  "puede haber un evento de algo que no pasó".

### Unit of Work sin acoplar la aplicación al ORM

`UNIT_OF_WORK` es una interfaz de una sola función (`run<T>(work)`). La implementación usa
`@nestjs-cls/transactional` con el adaptador de Prisma, de modo que los repositorios que corren
dentro toman automáticamente el cliente transaccional. La capa de aplicación puede decir
"esto es atómico" **sin importar Prisma ni pasar un `tx` por parámetro** a cada repositorio.

---

## 5. La regla de dependencias se verifica, no se promete

Una arquitectura en capas que solo vive en un diagrama dura hasta el primer viernes con prisa.
`.dependency-cruiser.cjs` la convierte en un error de CI (`npm run lint:arch`):

| Regla | Qué impide |
|---|---|
| `domain-is-pure` | Que el dominio importe algo que no sea `domain/` o `node:*` — ni un decorador de Nest |
| `application-no-outer-layers` | Que un caso de uso importe `infrastructure/` o `interface/` |
| `application-no-frameworks` | Que la aplicación importe cualquier paquete npm salvo `@nestjs/common`, `@nestjs-cls/transactional` y `tslib` |
| `no-generated-client-outside-infrastructure` | Que los tipos de Prisma se escapen fuera de `infrastructure/` |
| `no-cross-service-imports` | Que un servicio importe código de otro: se integran por HTTP y AMQP con contratos versionados |
| `packages-no-services` | Que un paquete compartido dependa de un servicio (inversión de la dirección) |
| `no-circular` | Ciclos de importación |

Dos detalles que costaron tiempo y vale la pena mencionar:

- `application-no-frameworks` incluye `npm-no-pkg` en `dependencyTypes`. Sin eso, un paquete
  *hoisteado* en la raíz del monorepo que el servicio no declara —y que llegó como dependencia
  transitiva— se importaría desde `application/` sin que la regla lo viera.
- `exclude` apunta a `^(packages|services)/[^/]+/(dist|coverage|test)/`, anclado al repo. Un
  `/dist/` suelto habría descartado también las dependencias npm que publican en `dist/`
  (axios, pino…), y las reglas habrían dejado de verlas sin avisar.

---

## 6. Qué devuelve esto en la práctica

No es arquitectura por estética. Lo que se compra con ella:

**Los tests de dominio y de aplicación corren sin Docker.** `test/fakes/in-memory.ts` implementa
los mismos puertos en memoria —incluido el rollback de `UnitOfWork`—, así que un caso de uso
completo se prueba en milisegundos. **Mockear Prisma, RabbitMQ o Redis está prohibido en este
repo**: un mock verifica que llamaste al método que creíste, no que el sistema funciona. Lo que
no cubren los fakes lo cubre `scripts/smoke.mjs` contra el stack real.

**Las reglas de negocio se leen en un archivo.** Para auditar "quién puede quedarse sin admin"
se lee `user-access.ts` y `user-profile.ts`. No hay que revisar controllers, triggers ni SQL.

**Los detalles son reemplazables donde importa.** Cambiar Mongo por otro store de auditoría toca
`infrastructure/persistence/`. Cambiar de ORM toca los repositorios y los mappers. Ninguna de las
dos cosas toca una regla de negocio.

**Y lo que cuesta, dicho sin adornos:** hay un mapeo extra (fila ↔ dominio ↔ vista), más archivos
por funcionalidad, y para un CRUD puro es sobreingeniería evidente. Por eso `audit` no lo paga
(§3). La regla práctica que se siguió: **la ceremonia se justifica cuando hay una invariante que
proteger**; si un agregado solo tiene getters y setters, es una tabla con disfraz.

---

## 7. Dónde está cada cosa

| Busco… | Archivo |
|---|---|
| Las reglas de roles y del último admin | `services/role-service/src/domain/{role/role.ts, access/user-access.ts}` |
| Bloqueo de cuenta por intentos fallidos | `services/auth-service/src/domain/security/lockout-policy.ts` |
| Suspensión y regla del último admin del lado de `user` | `services/user-service/src/domain/{profile/user-profile.ts, projection/user-roles-projection.ts}` |
| Qué puertos existen en un servicio | `src/domain/ports.ts` y `src/application/ports.ts` |
| Cómo se arma todo (composition root) | `src/app.module.ts` |
| El contrato público entre contextos | `packages/contracts/src/events/catalog.ts` |
| La regla de dependencias ejecutable | `.dependency-cruiser.cjs` |
| Cómo construir un servicio nuevo con esta forma | `docs/service-template.md` |
