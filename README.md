# Prueba Senior Full-Stack Engineer (IA) · Plataforma de gestión de usuarios

Sistema de gestión de usuarios construido con microservicios: autenticación, autorización por
roles, directorio de perfiles y auditoría, con una SPA de administración detrás de un API
gateway. Está pensado para levantarse completo con un comando y sin configuración previa.

> Este repositorio es la resolución de una prueba técnica. Si vienes a evaluarla, el
> **[mapa de rúbrica](docs/rubric-map.md)** toma cada viñeta del enunciado y dice dónde está y
> cómo comprobarla; el apartado [Estado y alcance](#estado-y-alcance) dice con precisión qué
> está terminado y qué no.

---

## Arranque rápido

**Requisitos:** Docker Engine 25 o superior, con **4–5 GB de RAM** asignados a Docker en
_Settings → Resources_. No hace falta Node ni ninguna clave de API.

```bash
git clone <este-repo> toka && cd toka
npm run up
```

El primer arranque construye siete imágenes y tarda unos minutos. Cuando termina, la aplicación
está en **<http://localhost:8080>**.

**El asistente de IA funciona sin clave de API.** Sin `GEMINI_API_KEY` arranca con un proveedor
_mock_ determinista: responde de verdad, con recuperación real sobre la base de conocimiento,
citas verificables y llamadas a herramientas, solo que sin un modelo de lenguaje detrás. La
pantalla lo dice con claridad para que nadie confunda la demostración con el sistema real. Para
usar Gemini, copia `.env.example` a `.env` y pon tu clave en `GEMINI_API_KEY`.

Para apagar: `npm run down`. Para apagar **y borrar los datos** (vuelve a la semilla):
`npm run reset`.

### Credenciales de demostración

Son datos sintéticos que se siembran al arrancar. Están en `.env.example` y se pueden cambiar.

| Usuario              | Contraseña        | Rol     | Qué puede hacer                                                                                |
| -------------------- | ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `admin@toka.local`   | `Admin123!demo`   | admin   | Todo: crear y editar usuarios, suspender, asignar roles, administrar roles y leer la auditoría |
| `auditor@toka.local` | `Auditor123!demo` | auditor | Leer usuarios, roles y auditoría. Sin acciones de escritura                                    |
| `viewer@toka.local`  | `Viewer123!demo`  | viewer  | Leer usuarios y roles. **No ve la auditoría**                                                  |

> El gateway limita el inicio de sesión a **5 intentos por minuto y por IP**. Si pruebas varias
> cuentas seguidas puedes recibir un `429`: espera un minuto. Es la protección funcionando, no
> un fallo.

### Un recorrido de cinco minutos

Este camino atraviesa casi todo el sistema:

1. Entra como **admin** y **crea un usuario** (la contraseña necesita 10 caracteres o más).
2. Observa que a los pocos segundos aparece en el listado **ya con el rol `viewer`**. Ese rol no
   lo puso la interfaz: lo asignó `role-service` al consumir el evento `account.registered`.
3. Cámbiale los roles desde el botón **Roles**. Son casillas sobre el catálogo completo porque
   la operación reemplaza el conjunto entero, no añade.
4. **Suspéndelo.** Después intenta suspenderte a ti mismo: verás que el botón ni siquiera
   aparece sobre tu propia fila.
5. Ve a **Auditoría** y busca el evento del alta. Copia su `correlationId`: es el hilo que
   permite seguir esa única acción a través de los cinco servicios.
6. Cierra sesión, entra como **viewer** y comprueba que _Auditoría_ desaparece del menú y que la
   tabla de usuarios ya no tiene columna de acciones.
7. Con la sesión abierta, **recarga la página**: la sesión sobrevive, porque se restaura con la
   cookie de refresco.
8. Vuelve a entrar como **admin**, abre **Asistente** y pregunta _«¿Quién puede suspender a un
   usuario?»_. La respuesta cita los pasajes que usó y puedes abrirlos. Después pregunta
   _«¿Cuántos usuarios activos hay?»_: verás un chip de herramienta, porque ese dato no está en
   la base de conocimiento y lo fue a buscar a `user-service` **con tu token**.
9. Entra como **viewer** y haz la misma pregunta sobre la auditoría: no recibe los pasajes
   restringidos ni se le ofrece la herramienta de auditoría. El asistente nunca ve más que quien
   pregunta.

---

## Arquitectura

```
                    ┌──────────────┐
  navegador ──────► │  gateway     │ :8080  (único puerto publicado)
                    │  (nginx)     │
                    └──┬────────┬──┘
                       │        │
                  ┌────▼───┐  ┌─▼──────────────────────────────┐
                  │  web   │  │  /api/v1/* → servicio dueño     │
                  │ (SPA)  │  │  /internal/* → 404              │
                  └────────┘  └─┬────────┬────────┬─────────┬──┘
                                │        │        │         │
                            ┌───▼──┐ ┌───▼──┐ ┌───▼──┐ ┌────▼───┐
                            │ auth │ │ user │ │ role │ │ audit  │
                            │ 3001 │ │ 3002 │ │ 3003 │ │ 3004   │
                            └───┬──┘ └───┬──┘ └───┬──┘ └────┬───┘
                                │        │        │         │
                     Postgres ──┴────────┴────────┘         │
                     (auth_db, user_db, role_db)            │
                     Redis    ──┴────────┘          Mongo ──┘
                                                   (audit_db)
                                │        │        │         │
                                └────────┴───RabbitMQ───────┘
                                        (toka.events)
```

| Servicio     | Responsabilidad                                                                | Almacén                   | Publica → Consume                                                                                |
| ------------ | ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------ |
| **auth**     | Identidad: cuentas, contraseñas, sesiones y emisión de JWT                     | Postgres `auth_db`, Redis | `account.registered`, `auth.*` → `user.status_changed`                                           |
| **user**     | Directorio de perfiles, estadísticas, suspensión                               | Postgres `user_db`, Redis | `user.profile_updated`, `user.status_changed` → `account.registered`, `role.assignments_changed` |
| **role**     | Roles, permisos y asignaciones (RBAC)                                          | Postgres `role_db`        | `role.*` → `account.registered`, `user.status_changed`                                           |
| **audit**    | Registro de todo lo que ocurre (solo lectura)                                  | Mongo `audit_db`          | — → `#` (todos los eventos)                                                                      |
| **ai-agent** | Asistente con RAG sobre la base de conocimiento y herramientas de solo lectura | Qdrant, Redis             | `agent.query_completed` → —                                                                      |
| **gateway**  | Único punto de entrada: ruteo, límites, cabeceras                              | —                         | —                                                                                                |
| **web**      | SPA de administración (React)                                                  | —                         | —                                                                                                |

### Cinco decisiones que explican el resto

**El gateway no valida tokens; cada servicio lo hace.** `auth` publica su clave pública en
`/.well-known/jwks.json` y los demás servicios la descargan y validan por su cuenta. Nadie le
pregunta nada a `auth` en cada petición, así que `auth` no es un cuello de botella ni un punto
único de fallo para el tráfico ya autenticado.

**Las contraseñas no salen de `auth`.** `auth` es dueño de las credenciales; `user` es dueño del
perfil. Por eso el alta de un usuario se pide a `auth`, que publica un evento, y `user` crea el
perfil al recibirlo. Un efecto visible: el token de sesión no trae el nombre de la persona, y la
SPA lo pide aparte a `user`.

**Casi toda la comunicación es por eventos; solo hay una llamada REST entre servicios.** En cada
inicio de sesión, `auth` le pregunta a `role` qué permisos tiene el usuario para firmarlos en el
token. Esa llamada tiene tiempo límite, reintentos y cortacircuitos, y si `role` no responde se
usa una copia reciente en Redis. Si tampoco hay copia, se responde `503`: **nunca se emite un
token sin permisos**, porque sería indistinguible de una cuenta legítimamente sin acceso.

**Los consumidores de eventos son idempotentes.** Cada servicio registra los eventos que ya
aplicó dentro de la misma transacción que el efecto, así que una reentrega de RabbitMQ no
duplica nada. `audit` lo consigue de forma más simple: usa el identificador del evento como
clave primaria, y la clave duplicada hace el trabajo.

**Hay dos reglas de negocio que cruzan servicios** —no se puede suspender al último
administrador activo, y nadie se suspende a sí mismo— y se resuelven **sin llamadas sincrónicas**:
cada servicio mantiene una proyección local que alimentan los eventos del otro. La ventana de
consistencia eventual está documentada en `docs/architecture.md`.

Más detalle en **[`docs/architecture.md`](docs/architecture.md)**. El porqué de cada una de
estas decisiones —y lo que cuesta— está en los **[ADR](docs/adr/README.md)**.

### Documentación

| Documento                                                            | Qué contiene                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`docs/rubric-map.md`](docs/rubric-map.md)                           | **Empieza por aquí si vas a evaluar:** cada viñeta del enunciado con dónde está y cómo comprobarla |
| [`docs/architecture.md`](docs/architecture.md)                       | El sistema: servicios, autenticación distribuida, flujos, mensajería, datos y compose              |
| [`docs/adr/`](docs/adr/README.md)                                    | Ocho decisiones de arquitectura con sus alternativas descartadas y lo que se paga por cada una     |
| [`docs/ddd-clean-architecture.md`](docs/ddd-clean-architecture.md)   | Cómo se aplican DDD y Clean Architecture en el código, y dónde se aplican a propósito menos        |
| [`docs/service-template.md`](docs/service-template.md)               | Cómo construir un servicio nuevo con esta forma, con las trampas que no se ven en los tests        |
| [`docs/ejercicio-4-diagnostico.md`](docs/ejercicio-4-diagnostico.md) | Ejercicio 4: diagnóstico de un incidente con 500s, auditoría que no se guarda y latencia de IA     |
| [`docs/ai/`](docs/ai/README.md)                                      | El agente: diseño, pipeline de RAG, prompts y evaluación, con ejemplos de `curl`                   |
| [`docs/coverage/README.md`](docs/coverage/README.md)                 | Resultados de cobertura y el razonamiento del umbral                                               |
| [`docs/spikes.md`](docs/spikes.md)                                   | Pruebas de viabilidad previas: Prisma 7 en CJS, imagen arm64, límites reales de Gemini             |

---

## Desarrollo

**Requisitos:** Node 24 (hay un `.nvmrc`; `nvm use` lo selecciona) y Docker para la
infraestructura.

```bash
nvm use            # Node 24: dependency-cruiser no funciona con Node 25
npm ci             # instala todos los workspaces y genera los clientes de Prisma
```

> `npm ci` avisa de «install scripts not covered by allowScripts». Es ruido de npm 11: los
> scripts de este repositorio sí se ejecutan y los clientes de Prisma se generan.

### Comandos

| Comando                              | Qué hace                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `npm run up`                         | Levanta todo como en producción: solo el gateway publica puerto                       |
| `npm run up:dev`                     | Igual, pero además publica las bases y los servicios en `127.0.0.1`                   |
| `npm run up:infra`                   | Solo Postgres, Mongo, Redis y RabbitMQ (para desarrollar un servicio fuera de Docker) |
| `npm run down` / `npm run reset`     | Apaga / apaga y borra los datos                                                       |
| `npm test`                           | Tests unitarios de todos los paquetes y servicios                                     |
| `npm run test:cov`                   | Igual, con cobertura y umbral                                                         |
| `npm run eval`                       | Evalúa el agente contra el golden set y escribe el reporte                            |
| `npm run smoke`                      | Prueba de punta a punta contra el stack real (**requiere `up:dev`**)                  |
| `npm run scan:secrets`               | Busca secretos en toda la historia de git (necesita `gitleaks`)                       |
| `npm run lint` · `npm run lint:arch` | Estilo · regla de dependencias entre capas                                            |
| `npm run typecheck`                  | TypeScript en todos los workspaces                                                    |
| `npm run web:dev`                    | Vite en `:5173` contra el backend del compose                                         |

### Estructura

```
packages/contracts     Eventos, permisos y topología. El lenguaje común entre servicios.
packages/nest-common   Logging, errores RFC 9457, guards JWT, AMQP y cliente HTTP resiliente.
services/<nombre>      Un microservicio. Ver docs/service-template.md.
web/                   SPA de administración.
infra/                 nginx del gateway y scripts de arranque de Postgres y Mongo.
scripts/smoke.mjs      Verificación de punta a punta.
```

Cada servicio sigue la misma estructura (dominio puro → aplicación → infraestructura →
interfaz). **`role-service` es la implementación de referencia** y
**[`docs/service-template.md`](docs/service-template.md)** explica cómo se construye uno nuevo,
incluidas las trampas que no se ven en los tests.

### Verificación

```bash
npm run up:dev && npm run smoke
```

El smoke comprueba **23 cosas** contra el sistema real: el inicio de sesión, que el mismo token
lo acepten los cuatro servicios, los `401`/`403`, que crear un usuario propague perfil, rol y
auditoría con el mismo `correlationId`, que suspender cierre el acceso, el conflicto de
versiones, la rotación del token de refresco y el bloqueo por intentos fallidos. Las cinco
últimas son del asistente: que cite la base de conocimiento, que use una herramienta con el
token de quien pregunta, que el `viewer` no reciba ni herramientas ni pasajes restringidos, que
niegue por omisión y que la consulta quede auditada sin guardar el texto de la pregunta.

**Cobertura:** el umbral es del 70 % en líneas, sentencias y funciones por servicio. Las ramas se
informan pero no bloquean, y los adaptadores de infraestructura quedan fuera del umbral a
propósito: los cubre el smoke contra el sistema real, no un mock. El razonamiento completo está
en [`docs/coverage/README.md`](docs/coverage/README.md).

---

## Seguridad

- **Contraseñas** con Argon2id. Del token de refresco solo se guarda su SHA-256, así que quien
  lea la base no puede renovar sesiones.
- **Token de acceso** de 10 minutos, solo en memoria del navegador: un XSS no se lleva la sesión.
  El de refresco viaja en una cookie `HttpOnly; SameSite=Strict` y **rota en cada uso**; si uno
  ya usado se vuelve a presentar, se revoca la sesión entera.
- **Bloqueo por intentos fallidos** combinando correo e IP, para que nadie pueda dejar fuera a
  una cuenta ajena solo conociendo su correo.
- **Denegación por omisión**: toda ruta exige token salvo que se marque pública, y cada una
  declara el permiso que necesita.
- `/internal/*` solo acepta tokens de servicio y el gateway además lo devuelve como `404`.
- **Nunca se commitea `.env`.** El sistema arranca entero sin él; `.env.example` documenta cada
  variable.

---

## Estado y alcance

Lo que está **terminado y verificado** desde un clon limpio, con volúmenes vacíos y **sin
`.env`** (es decir, sin ninguna clave de API):

- Los cinco microservicios, el gateway, la SPA y las cinco bases de datos (incluida Qdrant).
- El **asistente de IA**: RAG con ACL por permisos, siete herramientas de solo lectura sobre los
  microservicios, escalera de degradación y límites propios. Funciona con Gemini y sin clave.
- **374 tests** en verde; cada servicio por encima del umbral de cobertura.
- **Smoke de 23 comprobaciones**, dos corridas seguidas, incluidas las cinco de la Parte 2.
- Doce contenedores _healthy_, todos por debajo de su límite de memoria: poco más de 1 GB en
  total tras dos corridas del smoke.
- **Golden set de 12 casos** con runner de métricas: 100 % de acierto en mock y en vivo, con los
  reportes commiteados en [`docs/ai/reports/`](docs/ai/reports/).
- **Ningún secreto en la historia de git**: `npm run scan:secrets` pasa gitleaks sobre todos los
  commits. Las dos únicas excepciones son contraseñas sintéticas de tests, declaradas una por
  una y con su razón en [`.gitleaks.toml`](.gitleaks.toml).

El asistente también se probó **contra Gemini real** (con `.env`): responde citando los pasajes,
llama a `get_user_stats` para los datos en vivo y, cuando el modelo principal no contesta a
tiempo, baja al de respaldo sin que la comprobación falle.

La documentación está completa: arquitectura, ocho ADR, DDD y Clean Architecture, plantilla de
servicio, el **[diagnóstico del ejercicio 4](docs/ejercicio-4-diagnostico.md)**, la
documentación del agente y el **[mapa de rúbrica](docs/rubric-map.md)**, que enlaza cada viñeta
del enunciado con su artefacto y con la forma de comprobarlo.

**Lo que a propósito no está** —SQL Server, Kafka, una instancia de base por servicio, Keycloak,
LangChain, OpenTelemetry y el _transactional outbox_— está listado con su razón al final del
[mapa de rúbrica](docs/rubric-map.md#lo-que-no-está-y-por-qué). Ninguna de esas ausencias es un
descuido: todas tienen su decisión escrita.

### Solución de problemas

| Síntoma                                                   | Causa y salida                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `429` al iniciar sesión                                   | Límite del gateway (5/min por IP). Espera un minuto                                                                                                         |
| El asistente responde `422 AI_RATE_LIMITED`               | Son los límites propios del agente (4 consultas por minuto y usuario). El mensaje y la cabecera `Retry-After` dicen cuánto falta                            |
| El asistente dice «el modelo principal agotó su cuota»    | El _free tier_ de Gemini permite 20 peticiones diarias al modelo primario. El de respaldo sigue respondiendo; la cuota se renueva a medianoche del Pacífico |
| `npm run smoke` falla con `ECONNREFUSED`                  | El stack se levantó con `npm run up`, que no publica los puertos de los servicios. Usa `npm run up:dev`                                                     |
| `lint:arch` dice que la versión de Node no está soportada | Estás en Node 25. `nvm use`                                                                                                                                 |
| El puerto 8080 está ocupado                               | `GATEWAY_PORT=8099 npm run up`                                                                                                                              |
| Datos raros tras muchas pruebas                           | `npm run reset` vuelve a la semilla                                                                                                                         |
| Los contenedores no arrancan o se reinician               | Docker Desktop con menos de 4 GB. Súbelo en _Settings → Resources_                                                                                          |
