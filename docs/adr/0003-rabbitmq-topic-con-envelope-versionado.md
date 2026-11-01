# ADR 0003 · RabbitMQ (topic) con envelope versionado, retry/DLQ e idempotencia

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

Los servicios tienen que reaccionar a lo que pasa en otros —crear el perfil de una cuenta nueva,
asignar el rol por defecto, auditarlo todo— sin acoplarse en disponibilidad. Si `audit` se cae,
nadie más debería enterarse. La prueba pide explícitamente RabbitMQ.

## Decisión

Un exchange **topic** `toka.events`; la *routing key* es el tipo de evento
(`user.status_changed`), de modo que cada consumidor se suscribe a lo que le importa y `audit`
se suscribe a `#`.

**Envelope versionado y validado con zod** en `@toka/contracts`:
`eventId, type, version, occurredAt, producer, correlationId, actor, subject, data`.

Cada cola tiene su `.retry` (TTL 5 s, vuelve a la original) y su `.dlq`: tres intentos y luego
DLQ; un mensaje que no pasa el esquema va **directo** a la DLQ, porque reintentarlo no lo va a
arreglar.

Entrega *at-least-once* con **consumidores idempotentes**: `markProcessed(eventId)` en la
**misma transacción** que el efecto; `audit` lo consigue más barato usando `_id = eventId`.

## Alternativas y por qué no

- **Kafka.** Da retención y *replay*, que este dominio no necesita, a cambio de bastante más
  operación. RabbitMQ ya ofrece ruteo por tópico, DLQ y *dead-lettering* con TTL.
- **Llamadas REST en lugar de eventos.** Crear un usuario tendría que llamar a `user`, `role` y
  `audit` en línea: tres puntos de falla en el camino crítico, y `audit` caído rompería el alta.
- **Entrega *exactly-once*.** No existe en un sistema distribuido real; lo que existe es
  at-least-once con consumidores idempotentes, que es exactamente lo implementado.
- **Patrón *outbox* desde el principio.** Es lo correcto y está reconocido como la deuda
  principal (ver [ADR 0004](0004-clean-architecture-verificada.md) y la acción A1 del documento
  de diagnóstico), pero añade tabla, *relay* y operación; se dejó fuera del núcleo por plazo, con
  la pérdida acotada y registrada en el log.

## Consecuencias

- **Consistencia eventual visible:** tras crear un usuario, su perfil y su rol aparecen
  milisegundos después. La SPA lo asume en vez de fingir atomicidad.
- **Se publica después del commit.** Nunca se anuncia algo que no se guardó; el caso contrario
  —commit hecho, broker caído— deja el evento completo en el log y es justo lo que el outbox
  resolvería. Entre "puede faltar un evento, y se ve en el log" y "puede haber un evento de algo
  que no pasó", se eligió lo primero.
- **La DLQ es parte de la operación, no un accidente.** Cualquier mensaje que entre a una `.dlq`
  es una alerta pendiente (acción A2 del documento de diagnóstico).
- El `correlationId` viaja en los headers AMQP, así que un flujo completo —HTTP, evento,
  consumidor— se reconstruye con una sola búsqueda en los logs.
