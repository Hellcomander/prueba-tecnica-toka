# ADR 0001 · JWT RS256 con validación distribuida por JWKS

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

Cuatro servicios HTTP tienen que autorizar peticiones del mismo usuario. La prueba pide
"OAuth2/OIDC con JWT" y **validación distribuida**. Cada servicio necesita saber quién pide y qué
puede hacer, sin que eso convierta a `auth` en el cuello de botella de todo el tráfico.

## Decisión

`auth-service` es el **emisor**. Firma access tokens **JWT RS256** de 10 minutos con
`iss, sub, aud, exp, jti, sid, email, roles[], permissions[]`, y publica la llave pública en
`/.well-known/jwks.json` más un `/.well-known/openid-configuration` **limitado a los campos que
realmente implementa**.

Cada servicio **valida el token localmente** con esa llave pública: JWKS en caché 10 minutos, con
*refetch* si llega un `kid` desconocido. Guards globales que niegan por defecto
(`JwtAuthGuard` + `PermissionsGuard`), y cada ruta declara su permiso con
`@RequirePermissions('users:write')`; `@Public()` es la excepción explícita.

**El gateway no valida tokens.** Un servicio nunca asume que "alguien antes ya revisó".

## Alternativas y por qué no

- **Validar el JWT en el gateway y confiar en la red interna.** Rompe *zero-trust*: cualquier
  cosa que llegue a la red de backend —un contenedor comprometido, un servicio nuevo mal
  configurado— quedaría autorizada. El sobrecosto real de validar una firma RS256 en cada
  servicio es microsegundos.
- **Tokens opacos con introspección** (`POST /introspect` a `auth` en cada petición). Revocación
  inmediata, pero una llamada de red por request y `auth` como punto único de falla de **todo**
  el tráfico. Es el intercambio opuesto al que pide "validación distribuida".
- **Keycloak u otro IdP completo.** Cumple OIDC de verdad, pero cuesta ~500 MB de RAM y esconde
  exactamente lo que esta prueba quiere evaluar. Es el camino a producción (Authorization Code +
  PKCE), no el entregable.
- **HS256 con secreto compartido.** Todos los servicios podrían *emitir* tokens, no solo
  verificarlos. Con RS256 el secreto no sale de `auth`.

## Consecuencias

- Si `auth` cae, los tokens vigentes se siguen validando mientras cada proceso tenga la llave en
  caché. Un servicio que **arranca** con `auth` caído no puede validar hasta que vuelva.
- **Los permisos van dentro del token, así que un cambio tarda hasta 10 minutos en surtir
  efecto.** Es el precio explícito de no preguntar en cada request. Se acota con el TTL corto y,
  para suspensiones, con el evento `user.status_changed` que bloquea el refresh de inmediato. Una
  *denylist* por `jti` para revocación inmediata queda documentada como siguiente paso.
- `aud` y `token_use` separan los tokens de usuario de los de servicio (ver
  [ADR 0006](0006-una-sola-llamada-sincrona-que-falla-cerrado.md)).
