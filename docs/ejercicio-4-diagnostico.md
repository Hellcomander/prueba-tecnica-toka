# Ejercicio 4 · Diagnóstico de un incidente en producción

> **Escenario.** Producción reporta tres síntomas a la vez: **errores 500**, **registros de
> auditoría que no se están guardando** y **alta latencia del servicio de IA**.
>
> Este documento es el diagnóstico escrito: encuadre, hipótesis priorizadas con la evidencia que
> las confirma o descarta, el orden de investigación, qué falta instrumentar, lo específico de un
> componente de IA y cómo se comunica el incidente.

Todo lo que se cita aquí —rutas, nombres de cola, números— sale de este repositorio. Cuando
propongo una herramienta que **no existe** en el proyecto, lo digo de forma explícita con la
etiqueta **(propuesta)**.

**Nota de alcance.** Hoy `services/ai-agent-service/` contiene solo `package.json`, `tsconfig` y
`jest.config.cjs`: el servicio de IA no está implementado y `/assistant` es un marcador de posición
(*Estado y alcance* del `README.md`). El gateway sí tiene la ruta —`infra/gateway/nginx.conf` mapea
`^/api/v1/agent` a `ai-agent-service:3005` con `resolver 127.0.0.11` y la dirección en una
variable—, así que hoy esa ruta devolvería **502** por fallo de DNS, no latencia. El ejercicio se
responde sobre el sistema **tal como está diseñado y documentado** (`docs/architecture.md` §5.4 y
la sección Gemini de `docs/spikes.md`, que sí tiene mediciones reales del proveedor). Lo señalo
porque un diagnóstico que finge conocer código inexistente no se puede defender.

---

## 1. Encuadre: qué se sabe y qué no

Lo que tenemos son **tres síntomas**, no tres causas. Un síntoma es lo que el usuario o un panel
observa; una causa es el mecanismo que lo produce. Confundirlos es lo que lleva a "reiniciar el
pod" y a que el incidente vuelva treinta minutos después.

**Lo que se sabe, y lo que cada dato todavía no dice:**

- Llegan 5xx al cliente, pero no se sabe en qué rutas ni si son 500 genuinos o 503 de degradación
  controlada. La distinción es grande: `ProblemDetailsFilter`
  (`packages/nest-common/src/errors/problem-details.filter.ts`) marca cada error con un `code`
  estable, y `AUTHORIZATION_UNAVAILABLE` (503) significa algo muy distinto de `INTERNAL_ERROR` (500).
- Faltan registros de auditoría, pero no se sabe si **no se publicaron**, **no se consumieron** o
  **no se pudieron insertar** en Mongo. Son tres fallos con tres evidencias distintas.
- La IA responde lento, pero no se sabe si la demora está en recuperar el contexto, en el proveedor
  del modelo o en el bucle de herramientas.

**Lo que hace falta averiguar antes de tocar nada:**

| Pregunta | Por qué importa |
|---|---|
| ¿Desde cuándo? | Acota la ventana de cambios: despliegue, migración, pico de tráfico, llenado de un volumen |
| ¿Qué porcentaje del tráfico? | Un 2 % intermitente y un 100 % son incidentes distintos con urgencias distintas |
| ¿Qué rutas y qué `code`? | Un 500 en `POST /api/v1/accounts` y un 503 en `/api/v1/auth/login` apuntan a sitios opuestos |
| ¿Hubo despliegue, migración o cambio de configuración en las últimas horas? | La causa más probable de un incidente nuevo es un cambio reciente |

### ¿Una causa común o tres incidentes a la vez?

La pregunta determina toda la estrategia: si es una causa común, se arregla una cosa; si son tres,
el peor error es gastar la primera hora buscando la teoría elegante que lo une todo.

En esta arquitectura hay **tres componentes compartidos** por los tres síntomas, y por tanto tres
candidatos a causa común: **RabbitMQ** (`toka.events`, en la ruta de escritura de los cuatro
servicios y, según el diseño, también de `agent.query_completed`), **Postgres** (un contenedor con
`auth_db`, `user_db` y `role_db`) y **el host** (diez contenedores con límites de memoria ajustados).

La prueba rápida —**menos de diez minutos, sin cambiar nada**— son tres sondas independientes:

```bash
# 1. ¿Algún contenedor reiniciando o muerto por memoria?
docker compose ps --format '{{.Name}}\t{{.Status}}'
docker stats --no-stream

# 2. ¿RabbitMQ tiene alarma de recursos o publicadores bloqueados?
docker compose exec rabbitmq rabbitmqctl status | grep -i -A4 alarm
docker compose exec rabbitmq rabbitmqctl list_connections name state   # busca: blocked, blocking

# 3. ¿Las colas se están consumiendo?
docker compose exec rabbitmq rabbitmqctl list_queues \
  name messages messages_ready messages_unacknowledged consumers
```

**Regla de decisión:**

- Si `rabbitmqctl status` muestra una alarma de memoria o disco, o si hay conexiones en estado
  `blocked`/`blocking` → **una sola causa**, y explica los tres síntomas (ver H1). Se deja de
  buscar otra cosa.
- Si `audit-service.all` tiene `consumers = 0` o `messages_ready` creciendo, pero el resto del
  broker está sano → la auditoría está explicada aparte; 500 y latencia de IA siguen abiertos.
- Si los cuatro `/health/ready` responden 200, las colas están vacías y solo la IA es lenta →
  **son incidentes independientes** y se tratan en paralelo con dueños distintos.

El segundo criterio, más barato aún: **tomar un solo `correlationId` de una petición que falló y
seguirlo**. Si en ese mismo hilo aparecen el 500, la ausencia del evento en auditoría y la demora,
hay una causa común. Si no coinciden, no la hay.

---

## 2. Hipótesis priorizadas

La prioridad es **probabilidad × impacto ÷ coste de comprobación**, cada factor de 1 a 5
(probabilidad e impacto: más alto es peor; coste: más alto es más caro de comprobar). No es una
métrica científica: es una forma de obligarse a comprobar primero lo que es barato y explica mucho.

| # | Hipótesis | ¿Qué síntomas explica? | P | I | C | Prio. | Tiempo |
|---|---|---|---|---|---|---|---|
| **H1** | RabbitMQ en alarma de memoria: el broker **bloquea a los publicadores** | 500 · registros · IA | 3 | 5 | 1 | **15.0** | 5 min |
| **H2** | Consumidor de `audit-service.all` caído o atascado; mensajes acumulados o en `.dlq` | registros | 4 | 4 | 1 | **16.0** | 5 min |
| **H3** | Mongo: disco lleno, permiso denegado a `audit_svc` o índice faltante | registros · latencia de auditoría | 3 | 4 | 2 | **6.0** | 10 min |
| **H4** | Saturación del pool de Postgres (`max: 10` por servicio, `max_connections=60`) | 500 · lentitud general | 3 | 4 | 2 | **6.0** | 10 min |
| **H5** | S1 `auth → role` degradada: cortacircuitos abierto y sin copia *stale* en Redis → 503 | 500/503 en login | 3 | 5 | 2 | **7.5** | 10 min |
| **H6** | Proveedor de IA: latencia alta, 429 por cuota, reintentos ciegos o bucle de herramientas largo | IA | 4 | 3 | 3 | **4.0** | 20 min |
| **H7** | Efecto dominó: la IA lenta retiene conexiones y bloquea al resto | 500 · lentitud | 2 | 4 | 3 | **2.7** | 20 min |
| **H8** | OOM de un contenedor Node (`mem_limit 256m`, heap 160 MB) → reinicios → 500 y pérdida de consumidores | 500 · registros | 3 | 4 | 1 | **12.0** | 3 min |

A continuación, cada una con su mecanismo y su evidencia.

### H1 · RabbitMQ bloquea a los publicadores (la mejor candidata a causa común)

**Mecanismo.** RabbitMQ corre con `vm_memory_high_watermark {absolute,268435456}` (256 MB) y
`mem_limit: 384m`. Cuando el broker cruza esa marca **no se cae: aplica control de flujo y bloquea
a los publicadores**. En ese momento `AmqpConnection.publish()` —canal con *publisher confirms* y
`publishTimeout: 5_000`, en
`packages/nest-common/src/infrastructure/messaging/amqp-connection.ts`— añade **hasta cinco
segundos** a la petición HTTP que la originó, y luego falla.

Y aquí está lo importante: `AmqpEventPublisher.publish()` **captura la excepción y no la relanza**.
Registra `amqp.publish.failed` con el `payload` completo y devuelve con normalidad. El caso de uso
cree que publicó. El usuario recibe un 2xx. El evento no existe.

Eso produce los tres síntomas a la vez: **latencia** (+5 s por publicación en cada escritura,
incluida la del agente con `agent.query_completed`), **registros que no se guardan** (el evento
nunca llegó a `toka.events` y por tanto nunca a `audit-service.all`) y **500** cuando esa latencia
agota tiempos de espera aguas arriba o acumula peticiones en vuelo.

**Evidencia que la confirma:**

```bash
docker compose exec rabbitmq rabbitmqctl status | grep -i -A4 alarm
docker compose exec rabbitmq rabbitmqctl list_connections name state   # busca: blocked, blocking
docker compose logs --no-log-prefix --since 1h auth-service user-service role-service \
  | jq -c 'select(.event=="amqp.publish.failed") | {service, correlationId, type: .payload.type}'
```

**Evidencia que la descarta:** `alarms` vacío, ninguna conexión `blocked` y cero líneas
`amqp.publish.failed` en la ventana del incidente.

> **Detalle de ejecución.** `docker compose logs` antepone el nombre del contenedor a cada línea,
> lo que rompe `jq`. Hay que usar **`--no-log-prefix`** (el campo `service` ya viene dentro del
> JSON de pino, así que no se pierde nada). Vale para todos los comandos de este documento.

### H2 · El consumidor de auditoría está caído o atascado

**Mecanismo.** `audit-service.all` es la única cola con binding `#`
(`packages/contracts/src/topology.ts`): recibe *todos* los eventos. Si su consumidor muere o se
bloquea, los mensajes se acumulan en la cola —RabbitMQ los conserva, son `persistent`— y **nadie
aguas arriba se entera**, porque la publicación fue exitosa. Es exactamente el caso de "los
registros no se guardan sin que nadie vea un error".

Hay dos agravantes propios de este código. El primero: **`/health/ready` de audit no mira el
consumidor.** Por diseño explícito (`packages/nest-common/src/health/health.module.ts`), *ready*
solo valida el almacén propio —Mongo— para no encadenar fallos. Es la decisión correcta para la
rotación de tráfico, pero implica que **audit-service puede estar `healthy` en Docker, servir
`GET /api/v1/audit/events` sin problemas y no estar consumiendo nada**. Un panel de salud verde no
es evidencia aquí. El segundo: `AuditBootstrap.start()` reintenta con *backoff* exponencial
limitado a 30 s y registra `bootstrap.retry` en nivel `warn`; si el proceso vive pero nunca logra
suscribirse, el único rastro son esas líneas.

También puede estar atascado **sin estar caído**: con `prefetch: 10`, diez mensajes en vuelo cuyo
manejador no termina dejan la cola parada con `consumers = 1`. Por eso hay que mirar
`messages_unacknowledged`, no solo `consumers`.

Y el camino de muerte: un error de Mongo se relanza desde `MongoAuditRepository.append()`, el
mensaje se reintenta vía `audit-service.all.retry` (TTL 5 s) hasta `MAX_DELIVERY_ATTEMPTS = 3` y
después va a `audit-service.all.dlq` (`packages/nest-common/src/messaging/message-processing.ts`).
Un envelope inválido va a la DLQ de inmediato.

**Evidencia:**

```bash
docker compose exec rabbitmq rabbitmqctl list_queues \
  name messages messages_ready messages_unacknowledged consumers | grep audit

docker compose logs --no-log-prefix --since 1h audit-service | jq -c '
  select(.event=="amqp.message.dead_lettered" or .event=="bootstrap.retry" or .event=="amqp.disconnected")
  | {event, type, eventId, err: .err.message}'
```

| Lectura | Conclusión |
|---|---|
| `consumers = 0` | El consumidor no está suscrito → H2 confirmada, causa en audit-service o en la conexión |
| `consumers ≥ 1` y `messages_unacknowledged` alto y estable | Atascado en el manejador → mirar Mongo (H3) |
| `audit-service.all.dlq` con mensajes | Los eventos llegaron y fallaron al insertarse → H3 |
| Cola vacía, `consumers = 1`, DLQ vacía | Los eventos **nunca se publicaron** → H1 |

Ese último renglón es el que separa "no se consumió" de "no se publicó", y es la bifurcación más
importante del incidente.

### H3 · Mongo: disco, permisos o índices

**Mecanismo.** `audit_svc` tiene un rol a medida con **solo** `find`, `insert`, `createIndex` y
`listIndexes` sobre `audit_entries` (`infra/mongo/init/01-audit.js`). Es deliberado —la auditoría
es *append-only* a nivel de base de datos, verificado en `docs/spikes.md`— pero convierte cualquier
escritura que no sea `insertOne` en un `Unauthorized`. Si un despliegue introdujera un `updateOne`,
un `upsert` o un `createCollection` implícito, cada mensaje fallaría y acabaría en la DLQ. Por eso
el esquema de Mongoose va con `autoCreate: false` y `autoIndex: false`. El disco lleno produce el
mismo síntoma por otra vía: `insertOne` falla, se relanza, DLQ.

Caso aparte es la **latencia** de lectura: `GET /api/v1/audit/stats` ejecuta un `$facet` con dos
`$group` **sin `$match` previo** —un recorrido completo de la colección— y la SPA lo llama desde
`web/src/services/audit-api.ts`. Con un histórico grande carga la CPU de Mongo y compite con las
inserciones del consumidor. Es un candidato legítimo a "lentitud" sin relación alguna con la IA.

**Evidencia:**

```bash
docker compose exec mongo df -h /data/db

# Las comillas simples son necesarias: la contraseña vive en el entorno del CONTENEDOR,
# así que la expansión tiene que ocurrir dentro, no en el shell del host.
docker compose exec mongo sh -c 'mongosh --quiet --host mongo \
  -u audit_svc -p "$MONGO_AUDIT_PASSWORD" --authenticationDatabase audit_db audit_db \
  --eval "db.audit_entries.find().sort({occurredAt:-1}).limit(1)"'

docker compose exec mongo sh -c 'mongosh --quiet --host mongo \
  -u root -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
  --eval "db.currentOp({ secs_running: { \$gte: 3 } })"'
```

**La descarta:** disco con holgura, el último `occurredAt` es reciente y `currentOp` sin
operaciones largas.

### H4 · Agotamiento del pool de Postgres

**Mecanismo, con los números reales.** Hay **un** contenedor de Postgres con `max_connections=60`
(`docker-compose.yml`) para tres bases, y cada servicio abre su pool con
`new PrismaPg({ connectionString, max: 10 })`
(`services/*/src/infrastructure/persistence/prisma.service.ts`).

Conviene ser preciso, porque la versión genérica de esta hipótesis no se sostiene aquí: **3 × 10 =
30 conexiones**, la mitad del techo. Con una réplica por servicio, el `FATAL: sorry, too many
clients already` es improbable. Lo plausible es la **saturación del lado del cliente**: con diez
conexiones por servicio, la undécima consulta concurrente *espera* en el pool. Eso se ve como
latencia creciente y luego como tiempos de espera agotados, **sin un solo error en Postgres** —un
modo de fallo que un panel de Postgres sano no descarta. El servidor sí se agota al replicar: seis
instancias pasan de 60 y Postgres rechaza conexiones nuevas, lo que aparece como 500 simultáneos en
los tres servicios. Es el riesgo real de llevar este compose a producción sin un *pooler*.

**Evidencia:**

```bash
docker compose exec postgres psql -U postgres -c "show max_connections;"
docker compose exec postgres psql -U postgres -c \
  "select datname, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc;"
docker compose exec postgres psql -U postgres -c \
  "select pid, datname, state, now()-query_start as dur, left(query,60) \
   from pg_stat_activity where state <> 'idle' order by dur desc limit 10;"
```

Si `count(*)` por base ronda 10 y hay muchas en `idle in transaction`, es saturación del lado
cliente con transacciones que no cierran. Si el total se acerca a 60, es el techo del servidor.

### H5 · La llamada S1 de auth a role

**Mecanismo.** Es la única llamada REST síncrona entre servicios. En cada login y cada refresh,
`auth` pide los permisos a `role` para firmarlos en el token. `ResilientHttpClient`
(`packages/nest-common/src/http/resilient-http-client.ts`) la hace con **timeout de 1 s**, **2
reintentos** con *full jitter* y un cortacircuitos (`volumeThreshold: 5`,
`errorThresholdPercentage: 50`, `resetTimeout: 15_000`). `AuthorizationResolver`
(`services/auth-service/src/application/services/authorization-resolver.ts`) intenta la llamada y,
si falla, recurre a una copia reciente en Redis; si tampoco hay copia, **falla cerrado** con
`AUTHORIZATION_UNAVAILABLE`, que `ProblemDetailsFilter` traduce a **503**.

Esto explica 500/503 en el login **sin que `role-service` esté caído del todo**: basta con que se
degrade por encima del 50 % de fallos en la ventana de 10 s para que el cortacircuitos abra y
*todas* las peticiones siguientes fallen durante 15 s, incluidas las que `role` habría atendido. Es
la contrapartida conocida —y correcta— de un cortacircuitos: evita acumular peticiones colgadas.

El agravante silencioso está en Redis, que corre con
`--maxmemory 128mb --maxmemory-policy noeviction`. Con `noeviction`, un Redis lleno **rechaza las
escrituras**, y en `AuthorizationResolver` el guardado de la copia va con `.catch(() => undefined)`.
La copia *stale* deja de refrescarse sin que nadie lo note, y el siguiente tropiezo de `role` se
convierte en una tormenta de 503 en vez de una degradación limpia. La política es deliberada —los
contadores de bloqueo y de límite de tasa no deben desaparecer por presión de memoria—, pero tiene
este coste.

**Evidencia:**

```bash
docker compose logs --no-log-prefix --since 1h auth-service | jq -c '
  select(.event | startswith("breaker.")) | {time: .time, event, target}'

docker compose logs --no-log-prefix --since 1h auth-service | jq -c '
  select(.event=="http.client.call" and (.status==null or .status>=500))
  | {path, status, attempt, durationMs, breakerState}'

docker compose exec redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli info memory' \
  | grep -E 'used_memory_human|maxmemory_human'
```

Un `breaker.opened` con destino `role-service` en la ventana del incidente confirma la hipótesis.
`used_memory` pegado a 128 MB confirma el agravante.

### H6 · El servicio de IA

Cuatro causas distintas que producen el mismo síntoma, y hay que separarlas porque las acciones son
opuestas. Los números vienen de la sonda real documentada en `docs/spikes.md` (31-oct-2026):

| Causa | Qué se ve | Qué la confirma |
|---|---|---|
| **Latencia del proveedor** | `durationMs` del modelo alto y estable; sin errores | Comparar con la referencia medida: `gemini-3.5-flash` 2.9–4.5 s, `gemini-3.5-flash-lite` 0.4–0.6 s |
| **Modelo equivocado** | Latencias de minutos | La sonda midió **232 s** en `gemini-3.8-flash` sin timeout de cliente. Verificar `GEMINI_MODEL` en el entorno desplegado |
| **Cuota (429)** | `RESOURCE_EXHAUSTED` con `google.rpc.RetryInfo.retryDelay` y `QuotaFailure` | Contar 429 por minuto. El RPD se reinicia a medianoche hora del Pacífico, lo que produce un incidente que "se cura solo" a una hora fija |
| **Reintentos ciegos** | La tasa de 429 **sube** cuando el tráfico baja | Correlacionar peticiones salientes al proveedor contra peticiones entrantes de usuario: si la razón es > 1, el reintento está amplificando |
| **Bucle de herramientas largo** | Latencia total alta con latencia por llamada normal | Contar pasos por conversación: 1 llamada ≠ 5 llamadas encadenadas a `user`, `role` y `audit` |

El hallazgo más citable de la sonda: el SDK convierte el timeout del cliente en el encabezado
`X-Server-Timeout`, así que el `504 DEADLINE_EXCEEDED` lo emite el servidor al vencer ese plazo —no
es una falla del modelo. **Sin timeout propio, una petición de usuario puede quedarse colgada casi
cuatro minutos.** De ahí el límite de 15 s por llamada al LLM.

Además, el gateway limita `^/api/v1/agent` a `10r/m` por IP con `burst=5` y responde **429**
(`limit_req_status 429`), y nginx no fija `proxy_read_timeout`, por lo que rige el defecto de
**60 s**: una generación más lenta que eso se convierte en **504 del gateway**, no en un error del
agente. Conviene saberlo antes de buscar la causa donde no está.

### H7 · Efecto dominó

**Mecanismo.** El agente reenvía el JWT del usuario y llama a `user`, `role` y `audit` como
herramientas (`docs/architecture.md` §5.4). Si esas llamadas son lentas y no tienen límite de
concurrencia, cada conversación mantiene varias peticiones abiertas contra servicios que comparten
Postgres: el pool de 10 de `user-service` se agota atendiendo al agente y los usuarios normales
empiezan a esperar. El síntoma aparece en servicios que no tienen ningún problema propio.

**Evidencia:** en los logs de `user-service` y `role-service`, cruzar `durationMs` alto con el
origen de las peticiones del agente; en Postgres, ver si las consultas lentas vienen de `user_db`.
Se descarta si la latencia de `user` y `role` es normal mientras la IA está lenta.

### H8 · OOM de un contenedor Node

**Mecanismo.** Cada servicio Node tiene `mem_limit: 256m` y `NODE_OPTIONS=--max-old-space-size=160`.
Si un proceso supera el límite, Docker lo mata; con `restart: unless-stopped` vuelve, y durante el
arranque las peticiones en vuelo se cortan (500 o conexión reiniciada) y el consumidor de eventos
tarda en re-suscribirse. Es barato de comprobar y explica dos síntomas, así que entra temprano.

Hay precedente registrado en `docs/spikes.md`: unos healthchecks mal dimensionados (`mongosh` cada
5 s, `rabbitmq-diagnostics` cada 10 s) se acumularon bajo carga de CPU y mataron a Mongo por OOM.
**Un mecanismo de observabilidad mal dimensionado puede causar el incidente.** Si alguien añadió
sondas agresivas hace poco, es sospechoso número uno.

**Evidencia:**

```bash
docker compose ps --format '{{.Name}}\t{{.Status}}'          # ¿"Restarting"? ¿"Up 2 minutes"?
docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}}' \
  $(docker compose ps -q)
```

---

## 3. Plan de investigación, en orden

El orden no es por probabilidad: es por **coste, reversibilidad y riesgo de destruir evidencia**.
Primero lo que no cambia nada, después lo que cambia algo.

### Paso 0 · Congelar la evidencia (2 min, antes que nada)

Los logs van al controlador `json-file` con `max-size: 10m` y `max-file: 3`: **30 MB por
contenedor**. Durante un incidente, el volumen de logs se dispara y la ventana útil se rota y se
pierde. Lo primero es volcarlos a disco:

```bash
mkdir -p ./incidente-$(date +%FT%H%M) && cd $_
for s in gateway auth-service user-service role-service audit-service; do
  docker compose logs --no-log-prefix --since 3h "$s" > "$s.json.log"
done
docker compose ps > ps.txt && docker stats --no-stream > stats.txt
```

Y, por la misma razón, **no reiniciar nada todavía**: un reinicio borra el estado del proceso, el
contenido de las colas en vuelo y la memoria del cortacircuitos.

### Paso 1 · Topología viva (3 min)

`docker compose ps` y `docker stats`: quién está reiniciando, quién consume memoria, quién murió por
OOM (H8). Después, los cuatro `/health/ready`:

```bash
for p in 13001 13002 13003 13004; do curl -s -o /dev/null -w "$p %{http_code}\n" \
  "http://127.0.0.1:$p/health/ready"; done
# en producción, desde dentro:
docker compose exec audit-service wget -qO- http://127.0.0.1:3004/health/ready
```

Va primero porque es instantáneo y **descarta clases enteras de hipótesis**: cada `ready` valida
solo el almacén propio, así que un 503 señala con el dedo a Postgres o a Mongo. Con su límite ya
dicho: un 200 **no** garantiza que el consumidor de eventos esté vivo.

### Paso 2 · RabbitMQ (5 min)

La consola está en `127.0.0.1:15672` (publicada solo en local) y `rabbitmqctl` da lo mismo sin
navegador. Va segundo porque ahí se confirman o descartan de un vistazo H1 y H2 —las dos hipótesis
que explican "los registros no se guardan"—: alarmas, conexiones bloqueadas, profundidad de
`audit-service.all`, consumidores, mensajes sin confirmar y contenido de las cuatro `.dlq`.

### Paso 3 · La auditoría como fuente de la línea de tiempo (5 min)

La auditoría es el mejor reloj del incidente: **lo que dejó de registrarse, y desde cuándo, acota
el inicio**.

```bash
docker compose exec -T mongo sh -c 'mongosh --quiet --host mongo \
  -u audit_svc -p "$MONGO_AUDIT_PASSWORD" --authenticationDatabase audit_db audit_db \
  --file /dev/stdin' <<"JS"
db.audit_entries.aggregate([
  { $match: { occurredAt: { $gte: new Date(Date.now() - 6 * 3600 * 1000) } } },
  { $group: { _id: { $dateTrunc: { date: "$occurredAt", unit: "minute" } },
              n: { $sum: 1 }, tipos: { $addToSet: "$type" } } },
  { $sort: { _id: -1 } }, { $limit: 60 }
])
JS
```

El minuto en que el conteo cae a cero, o en que desaparece un `type` concreto, es el **t₀** del
incidente, y con él se busca qué cambió en ese minuto.

**Límite honesto de esta técnica, que hay que conocer antes de apoyarse en ella:** el documento
guarda `occurredAt` —cuándo ocurrió el evento en el productor— y **no guarda cuándo se insertó**.
Como `_id` es el `eventId` (un UUID aleatorio), tampoco se puede ordenar por inserción. Por eso, un
atasco que se drena más tarde reinserta documentos con `occurredAt` antiguos y el hueco "se rellena"
hacia atrás. Con esta colección **no se puede distinguir "dejó de producirse" de "dejó de
consumirse"**; para eso hay que mirar la cola (paso 2). Añadir un campo `recordedAt` es una de las
acciones de seguimiento.

### Paso 4 · Seguir una petición de punta a punta (10 min)

Aquí es donde el `correlationId` paga su coste. Nace en la SPA o lo genera nginx
(`map $http_x_correlation_id`, con `$request_id` de respaldo), cada servicio solo acepta un valor
con formato seguro `^[A-Za-z0-9-]{8,64}$` (`resolveCorrelationId`), viaja en los encabezados AMQP
como `x-correlation-id` y los consumidores lo reinstalan en el contexto junto a
`causationId = eventId`. `ProblemDetailsFilter` lo devuelve dentro del cuerpo
`application/problem+json`, así que **el usuario que reporta el fallo trae el identificador exacto**.

```bash
CID=9f2c1a44-0b8e-4b5a-9f22-3f6b7c1d2e55      # el que trae el reporte del usuario

for s in gateway auth-service user-service role-service audit-service; do
  echo "── $s"
  docker compose logs --no-log-prefix --since 2h "$s" \
    | jq -c "select(.correlationId==\"$CID\") | {time, level, event, msg, durationMs, userId}"
done
```

Y el barrido complementario: dónde están los 5xx y de qué tipo.

```bash
docker compose logs --no-log-prefix --since 1h \
  auth-service user-service role-service audit-service \
  | jq -c 'select(.msg=="request.failed") | {service, code, status, correlationId}' \
  | sort | uniq -c | sort -rn | head
```

El reparto de `code` por servicio es lo que separa un incidente de otro: todo `AUTHORIZATION_UNAVAILABLE`
en `auth-service` es H5; `INTERNAL_ERROR` repartido entre los tres servicios de Postgres es H4 o H1.

### Paso 5 · Las bases (10 min)

Las consultas de H3 y H4. Se dejan para el quinto lugar porque requieren entrar a los contenedores
de datos y porque, si los pasos 1–4 apuntaron a RabbitMQ, ya no hacen falta.

### Paso 6 · La IA, en su propio carril (20 min)

Se investiga en paralelo y con otro dueño, porque sus causas y sus métricas no se parecen a las del
resto (sección 5).

### Paso 7 · Confirmar la reparación con el smoke

`scripts/smoke.mjs` ejecuta **18 comprobaciones contra el sistema real**: los cuatro
`/health/ready`, que el mismo JWT lo validen los cuatro servicios, que crear un usuario propague
perfil, rol y auditoría **con el mismo `correlationId`**, el 409 por versión obsoleta, la rotación
del refresh y el bloqueo por intentos fallidos. Esa comprobación de propagación es justo la que
falla cuando los eventos no llegan, lo que convierte al smoke en la prueba de regresión natural de
este incidente.

```bash
npm run smoke        # requiere up:dev: publica los servicios en 127.0.0.1:13001-13004
```

Dos advertencias que evitan una falsa alarma: con `npm run up` (sin `:dev`) los puertos de los
servicios no están publicados y el smoke falla con `ECONNREFUSED`; y el smoke hace más de cinco
logins a propósito, por lo que va directo a los servicios para que el `429` del gateway no tape al
`429` del bloqueo por intentos. Es idempotente.

**El incidente se cierra cuando el smoke pasa dos veces seguidas**, no cuando los 500 dejan de
verse.

---

## 4. Qué falta instrumentar

Conviene ser directo sobre el punto de partida. Hoy el sistema tiene logs JSON con `service`,
`correlationId`, `userId`, `event` y `durationMs` y secretos redactados; propagación del
`correlationId` de punta a punta, mensajería incluida; `/health/live` y `/health/ready` por
servicio; la consola de RabbitMQ; y el smoke como verificación funcional.

Lo que **no** tiene: los logs **no están centralizados** —viven en el controlador `json-file` de
cada contenedor, con 30 MB de retención—, **no hay métricas, ni trazas distribuidas, ni alertas,
ni panel de DLQ**. Nada de Prometheus, Grafana, Loki ni OpenTelemetry está instalado. Todo lo que
sigue es **(propuesta)**.

### Durante el incidente: lo que se puede montar en horas

| # | Qué | Qué pregunta responde | Coste |
|---|---|---|---|
| D1 | **Agregación de logs** (propuesta: Loki + Promtail, o `docker compose logs` a un volumen) | "¿Qué pasó en los cinco servicios en ese minuto?" sin abrir cinco terminales ni perder la ventana por rotación | Horas |
| D2 | **Subir `LOG_LEVEL` a `debug`** en un servicio | Hace visible `amqp.published`, que hoy es nivel `debug` y **no se emite con el `info` por defecto**: sin él no se puede confirmar desde los logs que un evento se publicó, solo que falló | Minutos, pero **exige recrear el contenedor y eso destruye evidencia**. Solo después del paso 0 |
| D3 | **Panel de la DLQ** (propuesta: la consola de RabbitMQ sirve para leer; falta una vista con reenvío por *shovel*) | "¿Qué eventos se perdieron y cómo se reinyectan cuando esté arreglado?" | Horas |
| D4 | **Estado del consumidor expuesto** (propuesta: un campo informativo en `/health/live`, o `/internal/v1/consumer-status`, **sin** meterlo en `ready` para no romper la decisión de no encadenar fallos) | "¿Audit está consumiendo?" sin entrar al broker | Horas |

### Para que no vuelva a pasar

| # | Qué | Qué pregunta responde |
|---|---|---|
| P1 | **Métricas RED por servicio** (propuesta: `prom-client` + Prometheus + Grafana): tasa, errores y duración por ruta y por `code` | "¿Esto es normal o es un pico?" Hoy el `durationMs` existe en cada línea de log, pero **nadie lo agrega**: no hay p95 |
| P2 | **Métricas de mensajería**: profundidad por cola, **edad del mensaje más viejo**, consumidores activos, tasa de entrada a la DLQ (propuesta: habilitar el plugin `rabbitmq_prometheus`, que viene con RabbitMQ pero no está activado) | "¿Se está acumulando algo?" La *edad del mensaje más viejo* es la métrica clave: una cola de 500 mensajes drenándose está sana; una de 50 con un mensaje de 20 minutos, no |
| P3 | **Trazas distribuidas** (propuesta: OpenTelemetry, reutilizando el `correlationId` como `trace_id`) | "¿Dónde se fueron los 3 s del login: en argon2, en S1, en Postgres?" Hoy hay que sumar `durationMs` sueltos a mano |
| P4 | **Alertas** sobre: profundidad de `audit-service.all` por encima de N durante M minutos; **cualquier** mensaje en cualquier `.dlq`; edad del último evento auditado > 5 min; tasa de 503 `AUTHORIZATION_UNAVAILABLE`; `used_memory` de Redis cerca de `maxmemory`; alarma de memoria de RabbitMQ | Convierte "un usuario avisó" en "el sistema avisó" |
| P5 | **`recordedAt` en `audit_entries`** y **filtro por `correlationId` en la API** | Hoy `correlationId` y `subject.id` **están indexados en Mongo pero no son filtrables** por `GET /api/v1/audit/events`: el DTO solo acepta `type`, `category`, `actorId`, `from`, `to`, `cursor` y `limit`. Seguir un hilo en auditoría obliga a entrar a `mongosh` con credenciales de producción |
| P6 | **Acotar `GET /audit/stats`** con una ventana o un conteo precalculado | Elimina un recorrido completo de colección en una ruta que la SPA llama en cada carga del panel |

La distinción práctica: **durante** el incidente hace falta *ver*; **después** hace falta *avisar*.
Las alertas (P4) son lo que convierte el próximo incidente de 40 minutos en uno de 4.

---

## 5. Específico de IA: por qué la latencia de un LLM se diagnostica distinto

Un servicio de IA rompe cuatro supuestos con los que se diagnostica un microservicio normal.

**No se ve la cola del proveedor.** Con Postgres hay `pg_stat_activity`; con RabbitMQ,
`list_queues`. Con un proveedor de modelos no hay equivalente: la única señal son la latencia de las
respuestas y los 429. Cuando el proveedor se congestiona, no hay forma de distinguirlo de "nosotros
estamos lentos" salvo comparando contra una **línea base medida**. Por eso la sonda de
`docs/spikes.md` tiene valor operativo y no solo histórico: 2.9–4.5 s para `gemini-3.5-flash` y
0.4–0.6 s para `gemini-3.5-flash-lite` son el punto de comparación.

**El coste y la latencia dependen de los tokens, no de las peticiones.** Una petición de 200 tokens
y otra de 20 000 pesan igual en el contador de peticiones por minuto y difieren en órdenes de
magnitud en tiempo y dinero. Un contexto que crece —una conversación larga, una recuperación con
demasiados pasajes— sube la latencia sin que suba el tráfico. Además, los **tokens de razonamiento
se cobran y se reportan aparte** (`usage.thinking`) y Gemini 3 ignora `thinkingBudget: 0`, de modo
que hay que fijar `thinkingLevel: 'low'`: un cambio de modelo puede multiplicar el coste sin tocar
una línea del prompt.

**Los reintentos ciegos empeoran un 429.** Un `RESOURCE_EXHAUSTED` no es un fallo transitorio de
red: es el proveedor diciendo "para". Reintentar de inmediato consume la cuota restante y alarga el
bloqueo. La respuesta trae `google.rpc.RetryInfo.retryDelay` y `QuotaFailure`, y **ese plazo es el
que hay que respetar**, con *jitter* y sin reintentar más de una vez. Los límites del *free tier* se
aplican **por proyecto** y el RPD se reinicia a medianoche hora del Pacífico, lo que da una firma
reconocible: un incidente que empieza a una hora parecida cada día y se cura solo a otra hora fija.
Por eso el limitador propio arranca conservador y configurable: `AI_GLOBAL_RPM=8`,
`AI_GLOBAL_RPD=200`, `AI_USER_RPM=4`, `AI_USER_DAILY_TOKENS=50000`.

**Hay tres tiempos dentro de uno.** "La IA está lenta" es inservible como diagnóstico. Hay que
separar y medir por separado:

| Tramo | Qué se mide | Causa típica si domina |
|---|---|---|
| **Recuperación de contexto** | Latencia de la búsqueda vectorial (Qdrant) y número de pasajes | Índice frío, filtro de ACL caro, `k` demasiado alto |
| **Modelo** | Latencia por llamada, tokens de entrada / salida / razonamiento, modelo efectivo | Proveedor congestionado, modelo mal configurado, contexto inflado |
| **Herramientas** | Número de pasos y latencia de cada llamada a `user`, `role` y `audit` | Bucle de herramientas largo, o un servicio lento aguas abajo (H7) |

Si el tramo dominante es el de herramientas, el problema **no está en la IA**: está en el servicio
que la herramienta llama, y se diagnostica con la sección 3.

### Escalera de degradación

La respuesta no es "esperar a que el proveedor mejore", sino degradar de forma explícita y
observable. Los modelos se configuran por entorno (`GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`,
`GEMINI_EMBEDDING_MODEL`) y no hay identificadores fijos en el código, así que cada escalón es un
cambio de variable, no un despliegue.

| Escalón | Condición de entrada | Qué recibe el usuario |
|---|---|---|
| 1 · **Modelo primario** (`gemini-3.5-flash`) | Normal | Respuesta completa |
| 2 · **Modelo de respaldo** (`gemini-3.5-flash-lite`) | p95 por encima del umbral, o 429 sostenido | Respuesta completa, algo más breve. **Se avisa en la interfaz** |
| 3 · **Solo recuperación de contexto** | El proveedor no responde dentro del timeout de 15 s, o la cuota diaria está agotada | Los pasajes relevantes de la base de conocimiento, sin redacción, con la fuente citada. Sigue siendo útil |
| 4 · **Error claro** | Ni siquiera hay recuperación | `503` en `application/problem+json`, con `code` estable, `correlationId` y un mensaje que dice qué pasó y cuándo reintentar |

El escalón 4 es un diseño, no una rendición: un mensaje de error honesto con un identificador para
reportar es preferible a una respuesta inventada o a una espera de cuatro minutos. El mismo
principio que ya gobierna S1 en `AuthorizationResolver`: **fallar cerrado y decirlo**, antes que
devolver algo indistinguible de un resultado legítimo.

---

## 6. Comunicación

Dos audiencias con necesidades opuestas. El cliente necesita saber **qué no funciona, qué sí
funciona y cuándo habrá noticias**; el equipo necesita **hipótesis, evidencia y quién hace qué**.
Mezclarlas produce avisos llenos de jerga que no tranquilizan y canales internos llenos de disculpas
que no ayudan.

| Audiencia | Canal | Cadencia | Nivel de detalle |
|---|---|---|---|
| Clientes / usuarios | Página de estado y aviso dentro de la aplicación | Aviso inicial a los 15 min; actualización cada 30 min; resolución | Impacto y alternativa. Sin nombres de componentes internos |
| Responsables de producto / dirección | Canal de incidentes | Aviso inicial y cada hora | Impacto, alcance, estimación si existe. Sin especulación |
| Equipo técnico | Canal dedicado del incidente | Continua | Hipótesis, evidencia, comandos ejecutados, descartes |
| Seguridad / cumplimiento | Directo | De inmediato si hay hueco en la auditoría | **Obligatorio en este incidente**: hay un período sin registros de auditoría, y eso es un asunto de cumplimiento, no solo de disponibilidad |

Ese último renglón merece énfasis: cuando lo que falla es la auditoría, el incidente deja de ser
únicamente de disponibilidad. Hay que determinar y dejar por escrito **qué ventana de tiempo quedó
sin registrar** y si los eventos son recuperables desde las DLQ.

### Plantillas

**Aviso inicial — clientes (T+15 min).**

> **Investigando un problema en la plataforma de gestión de usuarios.**
> Desde aproximadamente las 14:05 (CDMX), parte de las operaciones de la plataforma está fallando o
> respondiendo con lentitud. Afecta al inicio de sesión y al asistente. La consulta de usuarios y
> roles sigue disponible.
> Estamos investigando de forma activa. La próxima actualización será a las 14:50, haya o no
> novedades.

**Aviso inicial — interno (T+15 min).**

> **INC-2026-10-31-01 · Severidad 2 · Responsable del incidente: @<persona>**
> **Síntomas:** 5xx en `/api/v1/auth/login`, sin entradas nuevas en `audit_entries` desde las 14:05,
> p95 de `/api/v1/agent` por encima de 20 s.
> **Hipótesis vivas:** H1 (RabbitMQ bloquea publicadores) y H2 (consumidor de audit atascado). H8
> descartada: ningún contenedor con `OOMKilled=true`.
> **En curso:** @<a> mira `rabbitmqctl list_queues` y las alarmas del broker; @<b> sigue el
> `correlationId` 9f2c…2e55 por los cinco servicios.
> **Evidencia congelada en** `./incidente-2026-10-31T1412/`. **No reiniciar nada** sin avisar aquí.
> Próxima actualización: 14:45.

**Actualización a mitad — clientes (T+45 min).**

> **Causa identificada; trabajando en la solución.**
> Localizamos el origen: un componente interno de mensajería dejó de procesar trabajo en segundo
> plano, lo que provocó lentitud y errores intermitentes. El inicio de sesión se ha estabilizado.
> Algunos registros de actividad generados entre las 14:05 y las 14:40 todavía no aparecen en la
> vista de auditoría; **no se han perdido** y se reincorporarán.
> Próxima actualización a las 15:20.

**Actualización a mitad — interno.**

> **INC-2026-10-31-01 · Actualización 2 · 14:45**
> **Confirmado H1.** `rabbitmqctl status` mostraba alarma de memoria (marca de agua de 256 MB) y 6
> conexiones en `blocking`. Con los publicadores bloqueados, `AmqpEventPublisher` registraba
> `amqp.publish.failed` y **no relanzaba**, así que las escrituras respondían 2xx sin publicar
> evento. Los +5 s de `publishTimeout` por petición explican la latencia.
> **H2 descartada:** `audit-service.all` tenía `consumers=1` y la cola vacía. No era que no se
> consumiera: no se publicaba.
> **Mitigación aplicada:** drenado de `user-service.events` (6 400 mensajes acumulados por un
> consumidor lento); alarma liberada a las 14:41.
> **Pendiente:** 212 mensajes en `audit-service.all.dlq` por reinyectar. Ventana sin auditoría:
> 14:05–14:41. Avisado a cumplimiento.

**Resolución — clientes.**

> **Resuelto.**
> El problema quedó resuelto a las 15:05. Entre las 14:05 y las 14:41 algunas operaciones fallaron o
> respondieron con lentitud; todas las que se completaron se registraron correctamente y los
> registros pendientes ya están reincorporados. Ninguna información se perdió.
> Publicaremos un análisis de lo ocurrido en los próximos días. Si notas algo fuera de lo normal,
> escríbenos con la hora aproximada: el mensaje de error incluye un identificador de seguimiento que
> nos permite localizar la operación exacta.

**Resolución — interno.**

> **INC-2026-10-31-01 · Resuelto · 15:05**
> Alarma del broker liberada, 212 mensajes reinyectados desde la DLQ (idempotentes por `_id =
> eventId`: no generaron duplicados). `npm run smoke` en verde dos corridas seguidas, incluida la
> comprobación de propagación con `correlationId`.
> Ventana degradada: 14:05–15:05. Ventana sin auditoría visible: 14:05–14:41, ya recuperada.
> Análisis posterior el 4 de noviembre, 10:00. Dueño del borrador: @<persona>.

**Resumen posterior, sin culpables (48–72 h).** Estructura fija, y una regla que se cumple sin
excepción: el documento describe **mecanismos y decisiones del sistema**, no personas. "El
publicador no propagaba el error de confirmación", nunca "fulano olvidó el `throw`". El objetivo es
que la siguiente persona que escriba un publicador tenga una barrera que se lo impida, no que esta
tenga cuidado.

> **Resumen del incidente INC-2026-10-31-01**
> **Impacto:** 60 minutos de degradación; 36 de ellos sin registros de auditoría visibles. Sin
> pérdida de datos.
> **Qué pasó:** un consumidor lento acumuló mensajes hasta que RabbitMQ cruzó su marca de agua de
> memoria y aplicó control de flujo. Los publicadores quedaron bloqueados y cada escritura sumó
> 5 segundos de espera antes de fallar.
> **Por qué no se detectó antes:** no hay alertas sobre profundidad de cola ni sobre la edad del
> mensaje más viejo. El primer aviso lo dio un usuario. Los cuatro `/health/ready` estuvieron en
> verde todo el incidente, porque por diseño solo validan el almacén propio.
> **Por qué fue silencioso:** el publicador de eventos captura el fallo de confirmación y lo
> registra sin relanzarlo, de modo que la petición HTTP respondía con éxito.
> **Qué cambia:** ver las acciones de seguimiento.

---

## 7. Cierre: acciones de seguimiento

Cada una atada a la hipótesis que la hizo necesaria. Sin dueño y sin fecha, una acción de
seguimiento es una intención.

| # | Acción | Atada a | Por qué |
|---|---|---|---|
| A1 | Que el fallo de publicación **sea visible**: contador de `amqp.publish.failed`, alerta a partir del primero, y decidir de forma explícita si una escritura cuyo evento no se confirmó debe responder con error o encolarse localmente (patrón *outbox*) | H1 | Es el mecanismo exacto que hizo silencioso el incidente |
| A2 | Alertas sobre **profundidad de cola** y **edad del mensaje más viejo** para las cuatro colas, y sobre cualquier mensaje entrante en cualquier `.dlq` | H1, H2 | El aviso lo dio un usuario, no el sistema |
| A3 | Exponer el **estado del consumidor** fuera de `/health/ready` —sin encadenar fallos— y mostrarlo en el panel operativo | H2 | Hoy audit puede estar `healthy` sin consumir nada |
| A4 | Añadir **`recordedAt`** a `audit_entries` y **`correlationId` como filtro** en `GET /api/v1/audit/events` | H2, H3 | Sin `recordedAt` no se distingue "no se produjo" de "no se consumió"; sin el filtro, seguir un hilo exige `mongosh` en producción |
| A5 | Alerta de disco de `/data/db` y revisión de que ningún camino de código intente `update`/`delete` sobre `audit_entries` (lo que el rol `auditAppendOnly` rechaza por diseño) | H3 | Convierte un fallo de permisos en un error de despliegue, no en una DLQ silenciosa |
| A6 | Revisar el dimensionado del pool: `max: 10` por servicio contra `max_connections=60` **no escala más allá de seis instancias**. Documentar el techo y evaluar un *pooler* (propuesta: PgBouncer) antes de replicar | H4 | Hoy funciona por tener una instancia de cada servicio; es una bomba de relojería al escalar |
| A7 | Alerta sobre `used_memory` de Redis acercándose a `maxmemory`, y métrica de **aciertos de la copia *stale*** en `AuthorizationResolver` | H5 | Con `noeviction`, un Redis lleno desactiva el respaldo de S1 sin que nadie lo note, y convierte una degradación de `role` en 503 masivos |
| A8 | Métrica de **tasa de apertura del cortacircuitos** por destino y prueba periódica del camino *stale* | H5 | El cortacircuitos es correcto; lo que falta es saber cuándo abre |
| A9 | Panel de IA con los **tres tramos separados** (recuperación, modelo, herramientas), tokens por petición y modelo efectivo en uso; respetar `RetryInfo.retryDelay` en lugar de reintentar a ciegas | H6 | "La IA está lenta" no es accionable; "el bucle de herramientas hace 7 pasos" sí |
| A10 | Límite de concurrencia del agente hacia `user`, `role` y `audit`, con su propio presupuesto de conexiones | H7 | Evita que una conversación lenta agote el pool de un servicio que no tiene ningún problema |
| A11 | Revisar que ninguna sonda de salud nueva sea más cara que su intervalo | H8 | Ya ocurrió una vez: los healthchecks de la primera versión mataron a Mongo por OOM (`docs/spikes.md`) |
| A12 | Instrumentación base en este orden: **agregación de logs → métricas RED y de colas → alertas → trazas** | Todas | Cada escalón hace útil al siguiente; las alertas sin métricas no existen, y las trazas sin agregación no se consultan |

El orden de A12 no es negociable por conveniencia: durante este incidente lo que faltó primero fue
**ver** (los logs estaban en cinco contenedores con 30 MB de retención) y lo que faltó después fue
**que el sistema avisara**. Las trazas distribuidas son lo que más ilusión hace y lo último que
hacía falta.
