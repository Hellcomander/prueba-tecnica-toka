# Mapa de rúbrica

Este documento existe para que revisar esta entrega no obligue a buscar nada. Toma **cada
viñeta del enunciado** —requisitos técnicos, requisitos de entrega y criterios de evaluación de
los cinco ejercicios— y dice dos cosas: **dónde está** y **cómo comprobarlo** sin confiar en mi
palabra.

Cuando una viñeta está resuelta de forma distinta a la que sugiere el enunciado (Postgres en vez
de SQL Server, Gemini en vez de OpenAI, eventos en vez de llamadas REST), la fila lo dice y
enlaza la decisión escrita. La última sección reúne, sin adornos, **lo que no está**.

---

## Comprobarlo todo de una vez

```bash
npm run up:dev && npm run smoke   # 23 comprobaciones de punta a punta contra el stack real
npm run test:cov                  # 374 tests unitarios + umbral de cobertura por servicio
npm run lint && npm run lint:arch # estilo + regla de dependencias entre capas
npm run typecheck                 # TypeScript estricto en los 8 workspaces
npm run eval                      # el agente contra el golden set de 12 casos
npm run scan:secrets              # gitleaks sobre toda la historia de git
```

`npm run smoke` requiere `npm run up:dev` (publica los puertos de los servicios en `127.0.0.1`);
el resto corre con `npm ci` y Node 24. **Nada de esto necesita una clave de API.**

---

## 1 · Diseño y Arquitectura de Software

### Requisitos técnicos

| Lo que pide el enunciado | Dónde está | Cómo comprobarlo |
| --- | --- | --- |
| **Microservicios:** al menos 3–4 independientes (Auth, User, Audit, Role) | Cinco: `auth`, `user`, `role`, `audit` y `ai-agent`, más el gateway nginx y la SPA. [`docs/architecture.md` §3](architecture.md) | `ls services/` · [`docker-compose.yml`](../docker-compose.yml) |
| **Comunicación:** síncrona (REST) y asíncrona (RabbitMQ o Kafka) | REST interno: `auth → role /internal/v1/authorizations/{userId}` en cada login. Asíncrona: RabbitMQ con exchange topic `toka.events` y envelope versionado. [§4](architecture.md), [§6](architecture.md), [ADR-0003](adr/0003-rabbitmq-topic-con-envelope-versionado.md), [ADR-0006](adr/0006-una-sola-llamada-sincrona-que-falla-cerrado.md) | Smoke: *«crear usuario propaga perfil, rol y auditoría con el mismo correlationId»* |
| **Estrategia de datos multi-DB** (SQL transaccional, MongoDB auditoría, Redis caché) | Postgres 17 con tres bases y un dueño por base (`auth_db`, `user_db`, `role_db`), MongoDB 8 para auditoría, Redis 7.4 para caché y límites, Qdrant para vectores. [§7](architecture.md), [ADR-0002](adr/0002-un-postgres-con-base-por-servicio.md) | [`infra/postgres/init/01-init.sh`](../infra/postgres/init/01-init.sh) · `docker compose ps` |
| **Integración de IA** en la arquitectura, con RAG | `ai-agent-service` como microservicio aparte, con RAG sobre Qdrant. [§5.4](architecture.md), [`docs/ai/agent-design.md`](ai/agent-design.md) | Smoke: *«el agente responde citando la base de conocimiento»* |
| **Ambiente dockerizado** ejecutable localmente con Docker Compose | [`docker-compose.yml`](../docker-compose.yml): 12 contenedores, todos con healthcheck, `mem_limit`, usuario no-root y defaults, en dos redes (`edge` / `backend`) | `npm run up` desde un clon limpio, **sin `.env`** |

### Requisitos de entrega

| Lo que pide el enunciado | Dónde está |
| --- | --- |
| Diagrama de arquitectura (visual o Mermaid) | Dos diagramas Mermaid en [`docs/architecture.md` §2 y §5.1](architecture.md), más el esquema ASCII del [README](../README.md#arquitectura) |
| Justificación de decisiones técnicas | [`docs/architecture.md`](architecture.md) tecnología por tecnología, y los **ocho [ADR](adr/README.md)**, cada uno con sus alternativas descartadas y su precio |
| Explicación del flujo de datos | [`docs/architecture.md` §5](architecture.md): login, alta de usuario (con su ventana de consistencia eventual), suspensión y pregunta al agente |
| Diseño del `docker-compose.yml` | [`docker-compose.yml`](../docker-compose.yml) real y funcional, explicado en [§10](architecture.md) |
| Cómo se aplican DDD y Clean Architecture | [`docs/ddd-clean-architecture.md`](ddd-clean-architecture.md), con la dosis distinta por contexto y el porqué |

### Criterios de evaluación

| Criterio | Dónde se sostiene |
| --- | --- |
| Claridad y cohesión arquitectónica | Un contexto por servicio, dueño único del dato: `auth` posee credenciales, `user` el perfil, `role` el RBAC. [`docs/ddd-clean-architecture.md` §2](ddd-clean-architecture.md) |
| Patrones adecuados (DDD, Clean Architecture, CQRS si aplica) | Capas verificadas por herramienta; CQRS ligero con `application/commands/` y `application/queries/` separados, sin bus. [§4](ddd-clean-architecture.md) |
| Seguridad y escalabilidad | JWT RS256 validado localmente por cada servicio (sin llamar a `auth` en cada petición), deny-by-default, rate limit en el borde. [§4](architecture.md), [ADR-0001](adr/0001-jwt-rs256-validacion-distribuida.md) |
| Comunicación síncrona y asíncrona | Una sola llamada síncrona, a propósito y documentada; el resto por eventos. [ADR-0006](adr/0006-una-sola-llamada-sincrona-que-falla-cerrado.md) |
| Estrategia multi-DB justificada | [ADR-0002](adr/0002-un-postgres-con-base-por-servicio.md): base por servicio lógica, un contenedor físico, y qué costaría separarlos |
| Integración de IA en la arquitectura | El agente no tiene base propia de negocio: lee a los demás servicios **con el token de quien pregunta**. [`docs/ai/agent-design.md`](ai/agent-design.md) |
| Dockerización completa y funcional | 12 contenedores *healthy* con `--wait`; un solo puerto publicado (8080) |
| **Resiliencia y manejo de fallos** | Timeout + reintentos + cortacircuitos en la llamada S1, copia *stale* en Redis y fallo cerrado si no hay copia; cola `.retry` con TTL y DLQ; escalera de degradación del agente. [ADR-0006](adr/0006-una-sola-llamada-sincrona-que-falla-cerrado.md), [ADR-0003](adr/0003-rabbitmq-topic-con-envelope-versionado.md) |

---

## 2 · Implementación de Microservicios

### Requisitos técnicos

| Lo que pide el enunciado | Dónde está | Cómo comprobarlo |
| --- | --- | --- |
| **3–4 microservicios independientes** | Cinco, en `services/`. Ninguno importa código de otro: lo impide `dependency-cruiser` | `npm run lint:arch` |
| **REST síncrono + al menos un ejemplo asíncrono** | REST: `GET /internal/v1/authorizations/{userId}`. Asíncrono: 13 tipos de evento en `toka.events` ([`packages/contracts/src/events/catalog.ts`](../packages/contracts/src/events/catalog.ts)) | Smoke: alta de usuario propagada a tres servicios con el mismo `correlationId` |
| **DDD y Clean Architecture en cada microservicio** | `src/domain` → `src/application` → `src/infrastructure` → `src/interface/http`, con dependencias en una sola dirección | `npm run lint:arch` falla si el dominio importa infraestructura |
| **OAuth2/OIDC distribuida (JWT con validación distribuida)** | `auth` emite RS256 y publica `/.well-known/openid-configuration` y `jwks.json`; los cinco servicios validan localmente con JWKS en caché. [ADR-0001](adr/0001-jwt-rs256-validacion-distribuida.md) | Smoke: *«el mismo JWT lo validan los 4 servicios»* y *«el discovery OIDC y el JWKS son públicos»* |
| **Multi-DB según diseño** | Postgres (3 bases) + MongoDB + Redis + Qdrant, cada uno en su contenedor | `docker compose ps` |
| **Dockerfile por microservicio + compose que orqueste todo** | Siete Dockerfiles multi-etapa ([`services/*/Dockerfile`](../services), [`web/Dockerfile`](../web/Dockerfile), [`infra/gateway/Dockerfile`](../infra/gateway/Dockerfile)), todos con usuario no-root | `npm run up` |
| **Tests unitarios con coverage mínimo del 70 %** | 374 tests; umbral de 70 % en líneas, sentencias y funciones por servicio (80 % en los paquetes compartidos), aplicado por `coverageThreshold` en [`jest.preset.cjs`](../jest.preset.cjs) | `npm run test:cov` — falla si algún servicio baja del umbral. Resultados en [`docs/coverage/README.md`](coverage/README.md) |
| **Logging estructurado (JSON)** | `nestjs-pino` en [`packages/nest-common/src/logging/`](../packages/nest-common/src/logging), con `service`, `correlationId`, `userId`, `event`, `durationMs` y redacción de credenciales | `docker compose logs auth-service \| tail -5` · el test `logger-options.spec.ts` comprueba la redacción |
| **Tecnologías requeridas** (Node.js/NestJS · ORM · DBs en contenedor · RabbitMQ · Docker) | NestJS 11 + TypeScript 5.9; **Prisma 7** como ORM con migraciones SQL versionadas y Mongoose para auditoría; Postgres, Mongo, Redis, RabbitMQ y Qdrant en contenedores | [`services/*/prisma/migrations/`](../services/role-service/prisma) · [`package.json`](../package.json) |

### Requisitos de entrega

| Lo que pide el enunciado | Dónde está |
| --- | --- |
| Código fuente de todos los microservicios | [`services/`](../services), más dos paquetes compartidos en [`packages/`](../packages) |
| Dockerfiles | Uno por servicio, por el gateway y por la SPA |
| `docker-compose.yml` funcional | [`docker-compose.yml`](../docker-compose.yml), con un override de desarrollo en [`docker-compose.dev.yml`](../docker-compose.dev.yml) |
| Tests unitarios con **coverage report** | [`docs/coverage/README.md`](coverage/README.md): política, exclusiones justificadas una por una y tabla de resultados |
| Documentación de cómo ejecutar el sistema | [README · Arranque rápido](../README.md#arranque-rápido): un comando, sin claves, con credenciales de demostración y un recorrido guiado |
| Explicación de DDD y Clean Architecture aplicados | [`docs/ddd-clean-architecture.md`](ddd-clean-architecture.md) y [`docs/service-template.md`](service-template.md) |

### Criterios de evaluación

| Criterio | Dónde se sostiene |
| --- | --- |
| Cumplimiento funcional | 23 comprobaciones de punta a punta en [`scripts/smoke.mjs`](../scripts/smoke.mjs) |
| Uso correcto de ORM y acceso a datos | Prisma 7 con driver adapter, bloqueo optimista por columna `version` y unidad de trabajo con `@nestjs-cls/transactional`, de modo que los casos de uso no conocen Prisma. [§4](ddd-clean-architecture.md) |
| Código limpio, seguro, SOLID | Inversión de dependencias por puertos: el dominio define la interfaz y la infraestructura la implementa. [§“El puerto lo define quien lo necesita”](ddd-clean-architecture.md) |
| DDD y Clean Architecture correctos | [`docs/ddd-clean-architecture.md`](ddd-clean-architecture.md), incluida la decisión consciente de aplicar DDD táctico **ligero** en `audit` por ser subdominio de soporte |
| Comunicación síncrona y asíncrona bien implementada | Reintentos con *jitter*, cortacircuitos, consumidores idempotentes y reordenamiento resuelto por `version` en el evento |
| Independencia y desacoplamiento | `npm run lint:arch`: ningún servicio importa a otro; solo comparten contratos |
| Autenticación distribuida funcionando | Smoke: un token emitido por `auth` abre `user`, `role` y `audit` sin que ninguno llame a `auth` |
| Tests con coverage adecuado | [`docs/coverage/README.md`](coverage/README.md) |
| Dockerización completa | 12 contenedores *healthy*, ~1,1 GB en estado estable |
| Logging estructurado | Ver arriba |
| **Consideración de seguridad OWASP** | Tabla siguiente |

### OWASP, viñeta por viñeta

| Riesgo | Cómo se trata | Dónde |
| --- | --- | --- |
| **A01 · Control de acceso roto** | Deny-by-default: toda ruta exige token salvo marca explícita, y cada una declara su permiso con `@RequirePermissions`. El agente **reenvía el token del usuario** y cada servicio vuelve a autorizar, así que la IA nunca ve más que quien pregunta | [`packages/nest-common/src/auth/guards.ts`](../packages/nest-common/src/auth/guards.ts) · smoke: *401/403*, *ACL del viewer* |
| **A02 · Fallos criptográficos** | Argon2id con los parámetros mínimos de OWASP (19 MiB, 2 iteraciones); del token de refresco solo se guarda su SHA-256; JWT RS256 con clave privada en un volumen que solo `auth` monta | [`argon2-password-hasher.ts`](../services/auth-service/src/infrastructure/security/argon2-password-hasher.ts) · [ADR-0007](adr/0007-refresh-opaco-en-cookie-access-en-memoria.md) |
| **A03 · Inyección** | `ValidationPipe` con `whitelist` + `forbidNonWhitelisted` (corta *mass assignment*); Prisma parametriza todo; el contexto del RAG va delimitado como datos y hay detector heurístico de inyección de prompts | [`validation.pipe.ts`](../packages/nest-common/src/validation/validation.pipe.ts) · [`guardrails/injection.ts`](../services/ai-agent-service/src/domain/guardrails/injection.ts) |
| **A04 · Diseño inseguro** | Invariantes dentro del agregado, no en el controller: no se puede quitar al último admin activo ni suspenderse a uno mismo | Smoke: *409 LAST_ADMIN*, *409 SELF_SUSPENSION* |
| **A05 · Configuración incorrecta** | Contenedores no-root, un solo puerto publicado, `/internal/*` devuelto como 404 por el gateway, cabeceras `X-Content-Type-Options`, `X-Frame-Options` y `Referrer-Policy` con `always`, errores en formato RFC 9457 sin *stack traces* | [`infra/gateway/nginx.conf`](../infra/gateway/nginx.conf) · smoke: *headers de seguridad*, */internal/* bloqueado* |
| **A07 · Fallos de identificación y autenticación** | Bloqueo por `(hash del correo, IP)` con *backoff*, verificación *dummy* de argon2 para correos inexistentes (mismo tiempo de respuesta) y rotación del token de refresco con revocación de la sesión si se reutiliza uno viejo | Smoke: *lockout 429*, *el refresh rota* |
| **A09 · Fallos de registro y monitoreo** | Auditoría append-only de todo lo que pasa, con `correlationId` que cruza los cinco servicios; los logs redactan credenciales y tokens | Smoke: *la consulta al agente queda auditada sin guardar el texto de la pregunta* |
| **Secretos** | `.env` nunca se versiona; el sistema arranca entero sin él; `gitleaks` corre sobre toda la historia | `npm run scan:secrets` |

---

## 3 · Desarrollo Front-end

### Requisitos técnicos

| Lo que pide el enunciado | Dónde está | Cómo comprobarlo |
| --- | --- | --- |
| **React o Angular con TypeScript** | React 19 + Vite + TypeScript estricto | [`web/`](../web) |
| **State management** (Redux/Zustand/NGRX) | Zustand, un store por dominio con `status` y `error` explícitos | [`web/src/state/`](../web/src/state) |
| **Integración con los microservicios** | A través del gateway, con interceptor de axios y refresco de sesión *single-flight* entre pestañas. Sin BFF: el gateway hace el ruteo | [`web/src/services/`](../web/src/services) · [`web/src/lib/api.ts`](../web/src/lib/api.ts) |
| **Estados de carga** | `status: 'idle' \| 'loading' \| 'ready' \| 'error'` en cada store; *skeletons* en las tablas | `web/src/state/*.ts` |
| **Manejo de errores** | Los errores RFC 9457 del backend se traducen a mensaje por campo o a *toast*; el `409` por versión obsoleta se explica al usuario, no se traga | `web/src/pages/users-page.spec.tsx` |
| **Validación de formularios** | `react-hook-form` + `zod`, con las mismas reglas que valida el backend | [`web/src/pages/`](../web/src/pages) |
| **Feedback visual** | *Toasts* de éxito y error, estados deshabilitados mientras hay petición en vuelo, y acciones que **no se renderizan** si falta el permiso | Entra como `viewer`: la tabla pierde la columna de acciones y *Auditoría* desaparece del menú |
| **Tests (Jest + React Testing Library)** | 55 tests en nueve archivos, montando los componentes reales con dobles de la capa de servicios | `npm test -w @toka/web` |
| **Front-end dockerizado en el compose** | [`web/Dockerfile`](../web/Dockerfile) (build Vite → nginx no-root) y el servicio `web` en el compose, detrás del gateway | `npm run up` y abrir <http://localhost:8080> |

### Requisitos de entrega

Código fuente ([`web/`](../web)), configuración de state management ([`web/src/state/`](../web/src/state)),
tests de componentes y de lógica, integración real con los microservicios del ejercicio 2,
documentación de ejecución ([README](../README.md#arranque-rápido) y `npm run web:dev` para
trabajar con Vite contra el backend del compose) y el `docker-compose.yml` actualizado.

### Criterios de evaluación

| Criterio | Dónde se sostiene |
| --- | --- |
| Funcionalidad de la UI | Login, dashboard, usuarios (listar, crear, editar, suspender, asignar roles), roles y auditoría con filtros y paginación por cursor |
| Uso correcto de state management | Stores por dominio, sin estado duplicado; el token de acceso vive **solo en memoria**, no en `localStorage` ([ADR-0007](adr/0007-refresh-opaco-en-cookie-access-en-memoria.md)) |
| Integración correcta | Todo pasa por el gateway; la SPA no conoce los puertos de los servicios |
| Manejo de estados | Carga, error y éxito explícitos en cada store |
| Calidad del TypeScript | `strict` activado; `npm run typecheck` |
| Tests funcionando | `npm test -w @toka/web` — 55 tests |
| UX básica | Recorrido de cinco minutos en el [README](../README.md#un-recorrido-de-cinco-minutos) |
| Dockerización del front | Servicio `web` en el compose |

---

## 4 · Desempeño bajo presión · Diagnóstico

Todo el ejercicio está en **[`docs/ejercicio-4-diagnostico.md`](ejercicio-4-diagnostico.md)**,
escrito contra *este* sistema: los comandos, los nombres de cola, las métricas y los códigos de
error son los reales, no genéricos.

| Lo que pide el enunciado | Dónde |
| --- | --- |
| Formular hipótesis sobre posibles causas | §2: **nueve hipótesis** priorizadas por probabilidad × impacto, cada una con su señal distintiva y su refutación rápida |
| Plan de diagnóstico sistemático con logs y herramientas | §3: ocho pasos cronometrados, empezando por congelar la evidencia antes de tocar nada |
| Cómo usaría **logs centralizados** | §3 paso 4 (seguir una petición por `correlationId` de punta a punta) y §4, que admite qué falta instrumentar y qué se monta en horas durante el incidente |
| Problemas específicos de agentes IA: latencia, costos de tokens, rate limiting | §5, incluida la escalera de degradación y por qué la latencia de un LLM se diagnostica distinto que la de un servicio normal |
| Cómo comunicaría el avance a stakeholders | §6: cadencia, plantillas y mensajes de ejemplo ya redactados para cada audiencia |

Sobre los criterios de evaluación: la priorización es explícita (H1 es la mejor candidata a
causa común de los tres síntomas), el orden de verificación está justificado, se consideran los
fallos en cascada (§H7) y el caso incómodo de que **no haya una sola causa sino tres incidentes
simultáneos** (§1).

---

## 5 · Integración de IA y Agentes

### Requisitos técnicos

| Lo que pide el enunciado | Dónde está | Cómo comprobarlo |
| --- | --- | --- |
| **Agente usando OpenAI, Azure OpenAI, Anthropic o Gemini** | **Gemini** (`@google/genai`) detrás del puerto `LlmProvider`, más un **proveedor mock determinista** para que el sistema arranque y se evalúe sin clave | [`infrastructure/llm/`](../services/ai-agent-service/src/infrastructure/llm) · `GET /api/v1/agent/kb/status` dice qué modo está activo |
| **RAG con vector database** (Qdrant local vale) | Qdrant en el compose; colección con filtro **ACL por permisos dentro de la consulta**, no después | [`vector/qdrant-store.ts`](../services/ai-agent-service/src/infrastructure/vector/qdrant-store.ts) · smoke: *el viewer no recupera pasajes de auditoría* |
| **Pipeline de embeddings para documentos/contexto** | Cinco documentos en español con front-matter de permiso → troceo por H2/H3 a 1000 caracteres con 150 de traslape → embeddings en lotes → upsert idempotente por hash. 32 pasajes indexados al arrancar | [`knowledge-base/`](../services/ai-agent-service/knowledge-base) · [`domain/knowledge/chunk.ts`](../services/ai-agent-service/src/domain/knowledge/chunk.ts) · [`docs/ai/rag-pipeline.md`](ai/rag-pipeline.md) |
| **Prompt engineering documentado** (system prompts, few-shot, CoT) | Dos prompts versionados (`agent-v1` zero-shot, `agent-v2` con cuatro ejemplos), *canary* en el system prompt y razonamiento nativo en nivel bajo sin exponer la cadena | [`application/prompts/agent-prompt.ts`](../services/ai-agent-service/src/application/prompts/agent-prompt.ts) · [`docs/ai/prompt-engineering.md`](ai/prompt-engineering.md) |
| **Evaluación: latencia** | p50/p95 y desglose por etapa (recuperación, LLM, herramientas) en cada respuesta y en el reporte | [`docs/ai/reports/`](ai/reports) |
| **Evaluación: coste de tokens (entrada/salida)** | `usage{input, output, thinking, embedding, costUsd}` en cada respuesta, con tarifas por modelo | Mock: **$0.005847** el golden set · Gemini: **$0.020134** |
| **Evaluación: validación básica de calidad** | Golden set de **12 casos** con comprobaciones duras (acierto) y blandas (indicios), por categoría: base de conocimiento, herramientas, informe, autorización, inyección y fuera de tema | `npm run eval` · [`scripts/eval/golden-set.mjs`](../scripts/eval/golden-set.mjs) · [`docs/ai/evaluation.md`](ai/evaluation.md) |
| **Integrado con al menos uno de los microservicios** | Con **tres**: siete herramientas de solo lectura sobre `user`, `role` y `audit`, invocadas **con el JWT de quien pregunta** y filtradas por sus permisos. Incluye «genera un reporte de accesos fallidos» | [`infrastructure/tools/http-tool-gateway.ts`](../services/ai-agent-service/src/infrastructure/tools/http-tool-gateway.ts) · smoke: *una pregunta de datos en vivo usa una herramienta con el token de quien pregunta* |

### Requisitos de entrega

| Lo que pide el enunciado | Dónde |
| --- | --- |
| Código del microservicio de IA | [`services/ai-agent-service/`](../services/ai-agent-service) |
| Pipeline de embeddings | [`application/commands/ingest-knowledge-base.use-case.ts`](../services/ai-agent-service/src/application/commands/ingest-knowledge-base.use-case.ts) y [`infrastructure/knowledge/`](../services/ai-agent-service/src/infrastructure/knowledge) |
| Documentación de prompt engineering | [`docs/ai/prompt-engineering.md`](ai/prompt-engineering.md) |
| Código de evaluación de respuestas | [`scripts/eval-agent.mjs`](../scripts/eval-agent.mjs) + [`scripts/eval/golden-set.mjs`](../scripts/eval/golden-set.mjs) |
| **Ejemplo de uso** del agente integrado | [`docs/ai/README.md`](ai/README.md): cinco `curl` copiables, incluido el contraste admin/viewer. También la pantalla **Asistente** de la SPA |
| Explicación de cómo se integra con el sistema | [`docs/ai/agent-design.md`](ai/agent-design.md) y [`docs/architecture.md` §5.4](architecture.md) |

### Criterios de evaluación

| Criterio | Dónde se sostiene |
| --- | --- |
| Integración funcional con los microservicios | Cinco comprobaciones del smoke son del agente, contra el stack real |
| RAG con vector database correcto | ACL dentro de la consulta a Qdrant; citas `[KB-n]` que la UI permite abrir y verificar contra el documento |
| Calidad del prompt engineering | Dos versiones comparables con el mismo golden set; [`docs/ai/prompt-engineering.md`](ai/prompt-engineering.md) explica qué cambió y qué mejoró |
| Evaluación implementada (latencia y costos) | Reportes commiteados en mock y contra Gemini real: **100 % de acierto** en ambos, con p50/p95, tokens y costo |
| **Manejo de errores y rate limiting de APIs de IA** | Reintentos que respetan el `RetryInfo` del 429 de Gemini, límites propios en Redis (RPM por usuario, RPM/RPD global y presupuesto diario de tokens), `Retry-After` hacia el cliente y **escalera de degradación**: modelo primario → modelo de respaldo → solo RAG con pasajes citados → 503. Cuando degrada, la respuesta dice por qué | [`redis/rate-limiter.ts`](../services/ai-agent-service/src/infrastructure/redis/rate-limiter.ts) · [`llm/gemini-errors.ts`](../services/ai-agent-service/src/infrastructure/llm/gemini-errors.ts) · [`docs/ai/agent-design.md`](ai/agent-design.md) |
| Consideración de costos y optimización de tokens | Caché de respuestas y de embeddings en Redis, `AI_MAX_OUTPUT_TOKENS`, razonamiento en nivel bajo y modelo de respaldo más barato. El costo del golden set está medido, no estimado |
| **Validación de respuestas del agente** | Validador de salida: citas que existen de verdad, redacción de secretos y marcado de entidades no verificables; el intento de inyección se marca en `flags` en vez de obedecerse | [`domain/guardrails/output-validator.ts`](../services/ai-agent-service/src/domain/guardrails/output-validator.ts) |

---

## Entregables esperados (última página del enunciado)

| Entregable | Estado |
| --- | --- |
| **Arquitectura:** diagramas y justificación · diseño del compose · DDD y Clean Architecture | [`docs/architecture.md`](architecture.md), [`docs/adr/`](adr/README.md), [`docs/ddd-clean-architecture.md`](ddd-clean-architecture.md) |
| **Microservicios:** código · Dockerfiles · compose funcional · tests con coverage report · documentación de ejecución | [`services/`](../services), [`docker-compose.yml`](../docker-compose.yml), [`docs/coverage/README.md`](coverage/README.md), [README](../README.md) |
| **IA y agentes:** código · pipeline de embeddings · prompt engineering · código de evaluación | [`services/ai-agent-service/`](../services/ai-agent-service), [`docs/ai/`](ai/README.md), [`scripts/eval-agent.mjs`](../scripts/eval-agent.mjs) |
| **Front-end:** código · state management · tests de componentes | [`web/`](../web) |
| **Análisis:** respuesta del ejercicio 4 | [`docs/ejercicio-4-diagnostico.md`](ejercicio-4-diagnostico.md) |

---

## Lo que no está, y por qué

Ninguna de estas ausencias es un descuido; todas son decisiones con su razón escrita.

| Qué | Por qué |
| --- | --- |
| **SQL Server / MySQL** | El enunciado deja elegir. Postgres 17 cabe en 8 GB de RAM y funciona nativo en arm64; SQL Server pide ≥2 GB él solo. [ADR-0002](adr/0002-un-postgres-con-base-por-servicio.md) |
| **Una instancia de base de datos por servicio** | Separación **lógica** (una base y un dueño por servicio, sin tablas compartidas) dentro de un contenedor. La frontera está donde importa; separar el contenedor es un cambio de compose. [ADR-0002](adr/0002-un-postgres-con-base-por-servicio.md) |
| **Kafka** | RabbitMQ cubre topic, retry con TTL y DLQ con mucha menos memoria. [ADR-0003](adr/0003-rabbitmq-topic-con-envelope-versionado.md) |
| **OpenAI / Azure OpenAI** | Gemini tiene *free tier* y el proveedor está detrás de un puerto: cambiarlo es un adaptador nuevo, sin tocar dominio ni aplicación |
| **Keycloak u otro IdP** | `auth-service` implementa la parte de OIDC que el sistema usa (discovery, JWKS, RS256). Montar Keycloak habría consumido el tiempo de los otros cuatro ejercicios. [ADR-0001](adr/0001-jwt-rs256-validacion-distribuida.md) |
| **LangChain / Semantic Kernel** | El enunciado acepta implementación directa. Con un *loop* de cuatro pasos y siete herramientas, un framework habría añadido una capa que esconde justo lo que esta prueba evalúa |
| **Umbral de cobertura en ramas** | El enunciado pide «coverage mínimo del 70 %» sin especificar métrica. Se aplica a líneas, sentencias y funciones; las ramas se informan. El razonamiento está en [`docs/coverage/README.md`](coverage/README.md) |
| **Cobertura unitaria de los adaptadores de infraestructura** | Excluidos del umbral **a propósito y por escrito**: los cubre el smoke contra el stack real. Un mock de Prisma comprueba el mock, no la query |
| **OpenTelemetry, Loki/Grafana, Kubernetes** | Fuera del alcance de una prueba local. [`docs/ejercicio-4-diagnostico.md` §4](ejercicio-4-diagnostico.md) dice qué falta instrumentar y en qué orden se montaría |
| **Transactional outbox** | Hoy se publica después de confirmar la transacción. La ventana de fallo y su solución están descritas en [`docs/architecture.md` §6](architecture.md); era el primer extra de la lista si sobraba tiempo |
