# Coverage

> Política definida en F0, antes de escribir código. La tabla de resultados se regenera en cada fase.

## Política

| Regla | Detalle |
|---|---|
| **Gate** | 70% en **lines, statements y functions** por servicio (80% en los paquetes compartidos). Lo hace cumplir `coverageThreshold` en `jest.preset.cjs`: si no se alcanza, `npm run test:cov` falla |
| **Branches** | Se reporta pero **no bloquea**. La prueba pide "coverage mínimo del 70%" sin especificar la métrica; los branches que generan los decorators y el código defensivo de infraestructura inflan el denominador sin aportar confianza |
| **Qué se prueba con unit tests** | Dominio (agregados, value objects, invariantes) y aplicación (casos de uso) con **repositorios fake en memoria** que implementan el mismo puerto. Controllers con casos de uso fake. Mappers Prisma ↔ dominio (funciones puras) |
| **Qué NO se mockea** | Prisma, RabbitMQ ni Redis. Un mock de Prisma prueba que llamaste al mock, no que la query funciona |
| **Quién cubre la infraestructura** | El smoke test end-to-end (`node scripts/smoke.mjs`) contra el stack real de Docker: login, JWT validado en los 5 servicios, eventos de punta a punta, 400 problem+json, 401, 403, 409 (dos `PATCH` con la misma versión), 429 y, en la Parte 2, el RAG con citas verificables, una herramienta real y el ACL del viewer |
| **Typecheck antes del gate** | `test:cov` corre `tsc -p tsconfig.json` antes de Jest. Jest solo transpila (`isolatedModules`), así que sin este paso un error de tipos pasaría los tests y rompería el build |

## Exclusiones del gate unitario (justificadas)

| Patrón | Por qué |
|---|---|
| `src/main.ts`, `src/**/*.module.ts` | Wiring de Nest sin lógica; si está mal, el servicio no arranca y el smoke falla |
| `src/**/index.ts` | Solo re-exports |
| `src/generated/**` | Cliente generado por Prisma |
| `src/infrastructure/persistence/**/*.repository.ts`, `*-repositories.ts`, `prisma.service.ts` | Adaptadores de BD: requieren la base real (además, Prisma 7 no ejecuta queries dentro de Jest 29 sin `--experimental-vm-modules`; ver `docs/spikes.md`) |
| `src/infrastructure/messaging/**`, `src/infrastructure/cache/**` | Adaptadores de RabbitMQ y Redis: los cubre el smoke test. Aplica igual en `@toka/nest-common`: la conexión al broker vive en `src/infrastructure/messaging/` |
| `ai-agent-service`: `llm/gemini-provider.ts`, `redis/**`, `knowledge/**` | Hablan con Gemini, Redis y el disco. Lo que tenían de lógica con reglas se extrajo a módulos puros —`gemini-errors.ts`, `aclFilter` (en `qdrant-store.ts`, que **sí** entra al gate), `buildPath`— y el proveedor mock entero se prueba porque es el que hace reproducible la evaluación |

La lógica de retry/DLQ del consumidor AMQP vive en `@toka/nest-common` separada del adaptador,
así que sí se prueba con unit tests (un mensaje fallido va a `.retry` y, tras 3 intentos, a la DLQ).

## Pruebas de integración (fuera del gate)

`packages/nest-common/test/amqp.int-spec.ts` corre el mismo flujo contra un **RabbitMQ real**
(topología completa: cola → `.retry` con TTL de 5 s → cola → … → `.dlq`, con el correlationId
del evento disponible en el handler). Requiere la infraestructura de Docker:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait rabbitmq
RABBITMQ_URL=amqp://toka:rabbit_dev_pw@127.0.0.1:15673 npm run test:int -w packages/nest-common
```

Sin `RABBITMQ_URL` la suite se omite. Su primera corrida destapó una carrera real (publicar
antes de que la topología quedara declarada); por eso `AmqpConnection.consume()` devuelve una
promesa que resuelve cuando la cola está declarada y suscrita.

## Resultados

Medidos con `npm run test:cov` (y `npm run test -w @toka/web`) sobre un clon limpio. El gate es
70% en lines, statements y functions; 80% en los paquetes compartidos.

| Paquete / servicio | Tests | Statements | Lines | Functions | Branches (informativo) |
|---|---:|---:|---:|---:|---:|
| `@toka/contracts` | 14 | 100% | 100% | 100% | 100% |
| `@toka/nest-common` | 44 | 97.33% | 99.43% | 94.87% | 85.22% |
| `auth-service` | 48 | 97.76% | 98.55% | 97.56% | 82.16% |
| `user-service` | 49 | 99.70% | 100% | 98.71% | 85.61% |
| `role-service` | 37 | 99.36% | 100% | 98.16% | 85.13% |
| `audit-service` | 33 | 99.09% | 100% | 94.44% | 87.09% |
| `ai-agent-service` | 94 | 87.68% | 88.67% | 83.47% | 73.98% |
| `@toka/web` | 55 | — | — | — | — |
| **Total** | **374** | | | | |

`ai-agent-service` queda por debajo del resto a propósito, no por descuido: una parte grande de
ese servicio son adaptadores cuya respuesta la pone un sistema externo (Gemini, Redis, el disco)
y probarlos con mocks comprobaría el mock, no el sistema. Lo que sí entra al gate es la lógica
con reglas, que se extrajo a módulos puros para poder probarla sin red: la traducción de los
errores del proveedor (`gemini-errors.ts`, con fixtures del 429 real), el filtro ACL que se manda
a Qdrant (`aclFilter`), la construcción de rutas de las herramientas (`buildPath`) y el proveedor
mock entero. El resto lo cubren el smoke y el golden set contra el stack real
([`../ai/evaluation.md`](../ai/evaluation.md)).

El front-end se prueba con Jest + React Testing Library montando los componentes reales con
dobles de la capa de servicios. No tiene umbral de cobertura: la prueba pedía el 70% por
servicio, y en una interfaz el número engaña (renderizar un componente cubre sus líneas sin
comprobar que haga lo correcto). Lo que se cubre está elegido por riesgo: el candado del refresco
entre pestañas, la restauración de sesión, la paginación por cursor, el conflicto de versiones y
que quien no tiene permiso no vea acciones de escritura.

Las cifras de ramas quedan por debajo del 90% sobre todo por el código defensivo de los
adaptadores y por las ramas que genera `emitDecoratorMetadata`; es exactamente el motivo por el
que la métrica se informa y no bloquea.
