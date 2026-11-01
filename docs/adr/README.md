# Registros de decisión de arquitectura (ADR)

Un ADR deja por escrito **una** decisión: el contexto en que se tomó, lo que se decidió, lo que se
descartó y **con qué se paga**. Son cortos a propósito; el detalle del sistema está en
[`../architecture.md`](../architecture.md) y el del código en
[`../ddd-clean-architecture.md`](../ddd-clean-architecture.md).

Formato: **Contexto → Decisión → Alternativas y por qué no → Consecuencias**. Todos tienen
estado *Aceptada*; ninguno se ha revertido todavía. Si una decisión cambia, no se edita el ADR:
se escribe uno nuevo que lo reemplaza.

Estas decisiones se tomaron para una prueba técnica con un plazo de uno a dos días y un objetivo
de demostración en una laptop de 8 GB. Donde esa restricción cambió la decisión respecto de lo
que se haría en producción, el ADR lo dice en vez de disimularlo.

| # | Decisión | Lo que se pagó |
|---|---|---|
| [0001](0001-jwt-rs256-validacion-distribuida.md) | JWT RS256 con validación distribuida por JWKS; `auth` es el emisor | Un permiso revocado tarda hasta 10 min en dejar de valer |
| [0002](0002-un-postgres-con-base-por-servicio.md) | Un Postgres con base y usuario por servicio; Mongo para auditoría | Aislamiento lógico, no físico: un `DROP` del contenedor se las lleva todas |
| [0003](0003-rabbitmq-topic-con-envelope-versionado.md) | RabbitMQ (topic) con envelope versionado, retry/DLQ e idempotencia | Sin replay histórico; consistencia eventual visible para el usuario |
| [0004](0004-clean-architecture-verificada.md) | Clean Architecture con la regla de dependencias verificada en CI | Más archivos y un mapeo extra por funcionalidad |
| [0005](0005-invariantes-cruzadas-con-proyecciones.md) | Invariantes entre contextos con proyecciones locales por eventos | Ventana de carrera entre servicios, documentada y acotada |
| [0006](0006-una-sola-llamada-sincrona-que-falla-cerrado.md) | Una sola llamada síncrona entre servicios (S1), que falla cerrado | Si `role` cae y no hay copia reciente, no se puede iniciar sesión |
| [0007](0007-refresh-opaco-en-cookie-access-en-memoria.md) | Refresh opaco rotado en cookie `HttpOnly`; access token solo en memoria | Recargar la página cuesta una petición de refresh |
| [0008](0008-monorepo-con-dos-paquetes-compartidos.md) | Monorepo npm workspaces con exactamente dos paquetes compartidos | Un cambio en `contracts` obliga a revisar los cinco servicios |
