# ADR 0008 · Monorepo npm workspaces con exactamente dos paquetes compartidos

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

Cinco servicios, una SPA y un entregable único. Hay código que sí debe compartirse —el esquema de
los eventos, el catálogo de permisos, el verificador de JWT— y código que **no** debe compartirse
nunca: las reglas de negocio de cada contexto. La frontera entre ambos es donde los monorepos se
echan a perder.

## Decisión

**npm workspaces** (`packages/*`, `services/*`, `web`) con un único `package-lock.json` y
versiones **fijadas**, sin rangos. **Exactamente dos** paquetes compartidos, con responsabilidades
que no se solapan:

- **`@toka/contracts`** — el *lenguaje publicado*: esquemas zod de eventos, envelope versionado,
  catálogo de permisos, roles de sistema, topología AMQP. **El contrato, no las reglas.** No hay
  ningún agregado aquí.
- **`@toka/nest-common`** — la plomería técnica: logs JSON con `correlationId`, filtro de errores
  `problem+json`, guards de JWT y permisos, conexión y publicación AMQP, cliente HTTP resiliente,
  módulo de health.

Y una regla verificada en CI: **ningún servicio importa código de otro**
(`no-cross-service-imports`), y **ningún paquete importa un servicio** (`packages-no-services`).
Los servicios se integran por HTTP y AMQP con contratos versionados.

## Alternativas y por qué no

- **Un repositorio por servicio.** Es lo correcto cuando hay equipos distintos con ciclos de
  despliegue propios. Para una entrega única convierte cada cambio de contrato en siete pull
  requests coordinados, y el evaluador tendría que clonar siete repos.
- **Un paquete compartido "core" con todo dentro.** El atajo clásico: empieza con utilidades y
  termina con un modelo `User` común que todos importan, lo que anula la separación de contextos
  ([ADR 0004](0004-clean-architecture-verificada.md)). Dos paquetes con nombres que explican qué
  cabe en cada uno hacen que meter un agregado ahí se vea raro en la revisión.
- **Nx o Turborepo.** Dan caché y grafo de tareas, que a esta escala no hacen falta, y añaden una
  capa de configuración que hay que saber defender. `npm workspaces` basta para siete paquetes.
- **Rangos de versiones (`^`).** Una instalación en otra máquina u otro día traería versiones
  distintas. Con versiones fijadas, lo que se evalúa es exactamente lo que se probó.

## Consecuencias

- **Un cambio en `@toka/contracts` obliga a revisar los cinco servicios.** Es el costo —y también
  la ventaja: el acoplamiento es visible en un solo diff, en vez de aparecer en producción cuando
  un consumidor recibe un campo que no esperaba.
- `tsconfig.depcruise.json` apunta los paths de `@toka/*` al código fuente, así que el análisis de
  arquitectura no depende de si los paquetes ya se compilaron.
- Un comando en la raíz corre todos los tests, el lint y la verificación de arquitectura; las
  imágenes Docker se construyen desde el contexto raíz con el mismo lockfile.
- Requiere **Node 24**: con Node 25, dependency-cruiser rechaza la versión. Está fijado en
  `.nvmrc` y en `engines`.
