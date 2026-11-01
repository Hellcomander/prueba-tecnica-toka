# ADR 0006 · Una sola llamada síncrona entre servicios (S1), que falla cerrado

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

El access token lleva `roles[]` y `permissions[]` para que cada servicio autorice **sin preguntar
a nadie** ([ADR 0001](0001-jwt-rs256-validacion-distribuida.md)). Pero al momento de firmarlo,
`auth` no tiene esos datos: son de `role`. Hay que ir a buscarlos.

## Decisión

**Exactamente una** llamada síncrona entre servicios de backend —`auth → role`, en login y
refresh— y está documentada como tal (**S1**). Todo lo demás es por eventos.

El cliente es resiliente: **timeout 1 s**, 2 reintentos con *full jitter* y **circuit breaker**.
Si `role` no responde, se usa una **copia *stale*** en Redis de hasta 10 minutos. Si tampoco hay
copia, responde **503 rápido**: *falla cerrado*.

La llamada también es zero-trust: `auth`, como emisor, firma para sí mismo un **token de
servicio** de 60 s con la misma llave RS256 (`sub: "service:auth-service"`,
`aud: "toka-internal"`, `token_use: "service"`, `scope: "authz:read"`). `role` lo valida con el
mismo JWKS en un `ServiceAuthGuard` sobre `/internal/*`. Un token de usuario no sirve en
`/internal/*` y uno de servicio no sirve en `/api/*`; además el gateway responde **404** a
`/internal/*` (defensa en profundidad).

## Alternativas y por qué no

- **Emitir el token sin permisos cuando `role` no responde.** Es la tentación de "degradar
  suavemente", y es un fallo de seguridad disfrazado: un token con `permissions: []` es
  **indistinguible** de una cuenta legítimamente sin acceso, así que el usuario ve una UI vacía
  en lugar de un error, y nadie se entera de que `role` está caído. Peor aún sería conceder
  permisos por defecto.
- **Que cada servicio consulte los permisos en cada request.** Elimina la ventana de 10 minutos,
  pero mete a `role` en el camino crítico de todas las peticiones del sistema.
- **Que `auth` mantenga su propia proyección de permisos por eventos.** Elimina la llamada, pero
  duplica la lógica de resolución de permisos en el servicio donde un error se paga más caro.
  La copia *stale* en Redis da el 90 % del beneficio con una fracción del riesgo.
- **mTLS o una malla de servicios** para autenticar S1. Es lo correcto en producción; aquí
  habría añadido una PKI y un *sidecar* para asegurar una única llamada, cuando la misma llave
  RS256 que ya existe resuelve el problema con un `aud` distinto.

## Consecuencias

- **Si `role` cae y no hay copia reciente, nadie puede iniciar sesión.** Es deliberado y es la
  contrapartida de no inventar permisos. Las sesiones ya abiertas siguen funcionando hasta que
  expire su token.
- Si Redis se llena (`maxmemory` con `noeviction`), el respaldo *stale* deja de funcionar sin
  avisar: es la acción A7 de [`../ejercicio-4-diagnostico.md`](../ejercicio-4-diagnostico.md).
- El breaker evita que `auth` acumule peticiones colgadas cuando `role` está caído, pero hoy no
  hay métrica de cuándo abre (acción A8).
- Un `client_credentials` estándar para clientes externos queda como extra documentado; el token
  de servicio interno cubre el caso real del sistema.
