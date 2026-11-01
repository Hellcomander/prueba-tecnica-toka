# ADR 0002 · Un Postgres con base y usuario por servicio; Mongo para auditoría

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

La prueba pide **multi-base de datos** y que ningún servicio lea la base de otro. El entorno de
evaluación es una laptop: el stack completo tiene que caber y arrancar con un comando. Tres
Postgres más Mongo, Redis y RabbitMQ no caben con holgura en 8 GB.

## Decisión

**Un contenedor de PostgreSQL 17 con tres bases** (`auth_db`, `user_db`, `role_db`), cada una con
**su propio usuario dueño**, sin permisos sobre las demás. El aislamiento lo garantiza Postgres,
no la buena voluntad del código.

**MongoDB 8** para la auditoría, con un usuario de aplicación que **no puede borrar ni
actualizar**: el read model es append-only por permisos del motor, no por convención.

**Redis 7.4** como estado efímero: caché de autorizaciones (S1), *lockout* de login y límites.
**Qdrant** para los vectores del agente (Parte 2).

ORM: **Prisma 7** en los tres servicios con Postgres (migraciones SQL versionadas y commiteadas,
`migrate deploy` al arrancar el contenedor) y **Mongoose** en `audit`.

## Alternativas y por qué no

- **Una instancia de Postgres por servicio.** Es lo correcto en producción —aislamiento de
  fallos, de recursos y de mantenimiento— y es lo que haríamos ahí. Aquí triplica la RAM para
  demostrar exactamente la misma propiedad de diseño. La separación lógica por usuario conserva
  lo que importa para la evaluación: **nadie puede leer la base de otro**.
- **Una sola base con esquemas por servicio.** La frontera dependería de la disciplina de cada
  `search_path`; un `JOIN` entre contextos sería trivial de escribir y difícil de detectar en
  revisión.
- **SQL Server**, nombrado en la vacante. Pide ≥ 2 GB de RAM y su soporte arm64 es pobre; habría
  consumido el presupuesto de memoria de todo lo demás.
- **Postgres también para la auditoría.** Habría funcionado, pero el read model recibe payloads
  con forma distinta por tipo de evento y crece sin parar: es el caso de uso natural de un store
  documental, y la prueba valora justificar cada herramienta.

## Consecuencias

- El aislamiento es **lógico, no físico**: las tres bases comparten CPU, memoria y destino. Una
  consulta pesada en `role_db` afecta a `auth_db`, y perder el contenedor las pierde todas. Está
  documentado como el primer cambio al ir a producción.
- `max_connections=60` con pools de 10 por servicio **no escala más allá de seis instancias**;
  hoy funciona porque hay una de cada una. Es la acción A6 de
  [`../ejercicio-4-diagnostico.md`](../ejercicio-4-diagnostico.md).
- Las migraciones se ejecutan al arrancar cada servicio: el orden lo resuelve `depends_on` con
  `service_healthy`, y un clon limpio levanta el esquema solo.
