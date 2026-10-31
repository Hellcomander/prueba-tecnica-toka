# Spikes de F0: decisiones validadas antes de escribir código de negocio

Objetivo: comprobar en la máquina real (macOS arm64, Docker Desktop con 4.8 GB, Node 24 LTS)
que el stack elegido funciona junto, y decidir los "planes B" **antes** de construir los
servicios, no a mitad del trabajo.

**Requisitos mínimos derivados:** Node 24 LTS (`.nvmrc`), Docker Engine ≥ 25 / Docker Desktop
≥ 4.27 con Compose v2 ≥ 2.20 (los healthchecks usan `start_interval`, que no existe en versiones
anteriores). Validado con Docker Engine 29.0.1.

## Resumen

| # | Qué se validó | Resultado | Decisión |
|---|---|---|---|
| 1 | Versiones fijadas (`npm view`) | `latest` ya trae Nest 12 (solo ESM), TS 7 y Vite 8 | Se fijan Nest 11.2.8, TS 5.9.3, Jest 29.7 + ts-jest 29.4, Prisma 7.10.1, `jose` 5.10 y `.npmrc` con `save-exact` |
| 2 | Prisma 7 en CommonJS (cliente sin motor Rust + `@prisma/adapter-pg`) | Genera con `moduleFormat = "cjs"` y `output` por servicio. En Node: query, create, transacción interactiva y bloqueo optimista (`updateMany` con `version` → `count 0` = 409) funcionan | **Se queda Prisma 7** (no hace falta el plan B con TypeORM) |
| 3 | Prisma 7 dentro de Jest 29 | Importar y construir el cliente funciona; **ejecutar queries falla** (`dynamic import callback was invoked without --experimental-vm-modules`: el query compiler WASM se carga con `import()`). Con `NODE_OPTIONS=--experimental-vm-modules` pasa | Confirma la política de coverage: los tests unitarios usan **repos fake en memoria**, nunca Prisma. Si se agregan tests de integración de repositorios, corren con ese flag |
| 4 | `amqp-connection-manager` 5 en Jest | Falla: depende de `promise-breaker` 7, que es solo ESM | Se fija **`amqp-connection-manager` 4.1.15 + `amqplib` 0.10.9** (línea estable y muy usada) |
| 5 | `jose` 5, `opossum` 10, `axios`, `nestjs-pino`, `nestjs-cls`, `@google/genai` 2.32 en Jest CJS | Cargan y funcionan (RS256 firmado y verificado contra un JWKS local) | Sin cambios |
| 6 | `@node-rs/argon2` (binario nativo) | argon2id hashea y verifica en darwin-arm64 (host) y en `node:24.22.2-alpine` linux-musl-arm64 (contenedor aislado). El lockfile incluye también linux-x64-musl para evaluadores con Intel | Sin cambios |
| 7 | Resolución de módulos de TypeScript | Con `module: node16`, `tsc` rechaza importar los tipos de `@google/genai` desde CommonJS (TS1479: el paquete es `"type": "module"`), y ts-jest exige `isolatedModules` con módulos híbridos | `module: node20` (TS 5.9 entiende `require()` de ESM, igual que Node 24) e `isolatedModules: true`: Jest solo transpila (más rápido) y el chequeo de tipos lo hace `npm run typecheck` |
| 8 | Infra en Docker (`--wait`) | Postgres, Mongo, Redis y RabbitMQ *healthy* en ~30 s; ~370 MB en estado estable | Ver hallazgo de healthchecks abajo |
| 9 | Imagen alpine multi-stage de role-service (`node:24.22.2-alpine`, arm64) | Corre como usuario `node`; `prisma migrate deploy` encuentra el motor `linux-musl-arm64`; queries, transacción y bloqueo optimista OK; los links de workspace (`@toka/*`) resuelven. Imagen de 177 MB comprimida | Etapa `deps` idéntica para los 5 servicios (`npm ci --ignore-scripts` con todos los manifests) para compartir cache; `prod-deps` solo instala lo de runtime del servicio. El CLI de Prisma pesa ~170 MB del `node_modules` de runtime: trade-off aceptado para migrar al arrancar (en producción sería un job aparte). La revisión posterior detectó que npm había anidado las dependencias AMQP en `packages/nest-common/node_modules` (artefacto de bajar de versión), que la imagen no copiaba: se re-hoistearon sin mover otras versiones y la etapa `runtime` ahora copia los directorios de workspace completos desde `prod-deps`, así que un anidamiento futuro tampoco rompe el arranque |
| 10 | Gemini real (`scripts/spike-gemini.mjs`) | Ver sección Gemini | Modelos solo por env |

## Hallazgo: healthchecks que tumban el stack

La primera versión usaba `mongosh` cada 5 s y `rabbitmq-diagnostics` cada 10 s. Cada chequeo
levanta un proceso pesado (mongosh es Node, ~70–100 MB; diagnostics levanta una VM de Erlang).
Con la CPU compartida por un build, los chequeos tardaron más que su intervalo, **se acumularon**
y Mongo murió por OOM (límite de 512 MB) y RabbitMQ se reinició.

Corrección:
- `start_interval: 2s` durante el arranque e `interval: 30s` después.
- Mongo: `exec mongosh … --eval 'quit(...)'`, sin pipe a `grep`, para que Docker pueda matar el
  proceso si excede el timeout.
- RabbitMQ: chequeo TCP con `nc -z 127.0.0.1 5672` (equivale a `check_port_connectivity`).

Resultado: CPU de la infra en reposo < 10% y memoria estable. Es un buen ejemplo para el
ejercicio 4: un mecanismo de observabilidad mal dimensionado puede causar el incidente.

## Hallazgo: mínimo privilegio verificado en Mongo

El usuario `audit_svc` tiene un rol propio con `find`, `insert`, `createIndex` y `listIndexes`
sobre `audit_entries`. Verificado: `insertOne` funciona; `deleteOne` y `updateOne` responden
`Unauthorized`. La auditoría es append-only **a nivel de base de datos**, no solo por código.

## Gemini (free tier, 31-oct-2026)

Se ejecutó `npm run spike:gemini` (equivale a `node --env-file-if-exists=.env
scripts/spike-gemini.mjs`; la key nunca se imprime; solo datos sintéticos) y una sonda de
latencia con una llamada por modelo y configuración.

| Modelo | Tool call `get_user_stats` | Latencia | Tokens (in / out / thinking) |
|---|---|---|---|
| `gemini-2.5-flash` | 404 "no longer available to new users" | — | — |
| `gemini-3.8-flash` (el que recomienda el propio error) | 1ª corrida, **sin timeout de cliente**: correcta. 2ª y 3ª, con timeout de cliente de 45 s: **504 DEADLINE_EXCEEDED** | **232 s**; luego > 45 s | 47 / 12 / 72 |
| `gemini-3.5-flash` | Correcto | 2.9–4.5 s | 38–47 / 12 / 85–95 |
| `gemini-3.5-flash-lite` | Correcto | 0.4–0.6 s | 38 / 12 / 0 |
| `gemini-embedding-001` (768 dims) | — | 0.2–0.3 s | — |

Decisiones:
- **Primario `gemini-3.5-flash`, fallback `gemini-3.5-flash-lite`, embeddings
  `gemini-embedding-001` a 768 dimensiones.** Todo se configura por env (`GEMINI_MODEL`,
  `GEMINI_FALLBACK_MODEL`, `GEMINI_EMBEDDING_MODEL`); el código no tiene IDs de modelo fijos.
- **Timeout por llamada al LLM** (15 s) y escalera de degradación: el modelo "más nuevo" fue el
  más lento. Nota sobre el 504: el SDK convierte el timeout del cliente en el header
  `X-Server-Timeout`, así que es el servidor el que corta al vencer ese plazo; el 504 significa
  "tardó más de 45 s", no una falla del modelo. Es evidencia para el ejercicio 4: sin timeout
  propio, un request de usuario puede quedarse colgado casi 4 minutos.
- Gemini 3 ignora `thinkingBudget: 0`; se usa `thinkingLevel: 'low'`. Los tokens de
  razonamiento se cobran y se reportan aparte en `usage.thinking`.
- **429:** 30 llamadas concurrentes a `gemini-3.5-flash-lite` no provocaron un 429. No se gastó
  más cuota en forzarlo. La forma documentada (`RESOURCE_EXHAUSTED` con
  `google.rpc.RetryInfo.retryDelay` y `QuotaFailure`) se cubre con un fixture en los tests del
  adaptador.
- **Límites del free tier:** Google los aplica **por proyecto** (no por key), dependen del tier
  del proyecto y solo se publican en AI Studio (*Rate limits*); el RPD se reinicia a medianoche
  hora del Pacífico. Una fuente secundaria (octubre 2026, no oficial) indica del orden de
  10 RPM / 500 RPD para Flash-Lite y ~20 RPD para Flash; que 30 llamadas concurrentes no dieran
  429 sugiere que este proyecto tiene límites mayores. Por eso el rate limiter propio arranca
  conservador y configurable (`AI_GLOBAL_RPM=8`, `AI_GLOBAL_RPD=200`, `AI_USER_RPM=4`,
  `AI_USER_DAILY_TOKENS=50000` en `.env.example`) y se ajusta en F5 con los números que muestre
  AI Studio para el proyecto.
