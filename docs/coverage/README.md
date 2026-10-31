# Coverage

> Política definida en F0, antes de escribir código. La tabla de resultados se genera en F7.

## Política

| Regla | Detalle |
|---|---|
| **Gate** | 70% en **lines, statements y functions** por servicio (80% en los paquetes compartidos). Lo hace cumplir `coverageThreshold` en `jest.preset.cjs`: si no se alcanza, `npm run test:cov` falla |
| **Branches** | Se reporta pero **no bloquea**. La prueba pide "coverage mínimo del 70%" sin especificar la métrica; los branches que generan los decorators y el código defensivo de infraestructura inflan el denominador sin aportar confianza |
| **Qué se prueba con unit tests** | Dominio (agregados, value objects, invariantes) y aplicación (casos de uso) con **repositorios fake en memoria** que implementan el mismo puerto. Controllers con casos de uso fake. Mappers Prisma ↔ dominio (funciones puras) |
| **Qué NO se mockea** | Prisma, RabbitMQ ni Redis. Un mock de Prisma prueba que llamaste al mock, no que la query funciona |
| **Quién cubre la infraestructura** | El smoke test end-to-end (`node scripts/smoke.mjs`) contra el stack real de Docker: login, JWT validado en los 4 servicios, eventos de punta a punta, 400 problem+json, 401, 403, 409 (dos `PATCH` con la misma versión) y 429 |
| **Typecheck antes del gate** | `test:cov` corre `tsc -p tsconfig.json` antes de Jest. Jest solo transpila (`isolatedModules`), así que sin este paso un error de tipos pasaría los tests y rompería el build |

## Exclusiones del gate unitario (justificadas)

| Patrón | Por qué |
|---|---|
| `src/main.ts`, `src/**/*.module.ts` | Wiring de Nest sin lógica; si está mal, el servicio no arranca y el smoke falla |
| `src/**/index.ts` | Solo re-exports |
| `src/generated/**` | Cliente generado por Prisma |
| `src/infrastructure/persistence/**/*.repository.ts`, `prisma.service.ts` | Adaptadores de BD: requieren la base real (además, Prisma 7 no ejecuta queries dentro de Jest 29 sin `--experimental-vm-modules`; ver `docs/spikes.md`) |
| `src/infrastructure/messaging/**`, `src/infrastructure/cache/**` | Adaptadores de RabbitMQ y Redis: los cubre el smoke test. Aplica igual en `@toka/nest-common`: la conexión al broker vive en `src/infrastructure/messaging/` |

La lógica de retry/DLQ del consumidor AMQP vive en `@toka/nest-common` separada del adaptador,
así que sí se prueba con unit tests (un mensaje fallido va a `.retry` y, tras 3 intentos, a la DLQ).

## Resultados

_Se completa en F7 con la tabla por paquete, servicio y front-end._
