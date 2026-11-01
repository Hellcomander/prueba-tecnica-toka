# ADR 0007 · Refresh opaco rotado en cookie `HttpOnly`; access token solo en memoria

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

Una SPA necesita mantener la sesión entre recargas sin dejar credenciales al alcance de cualquier
script. La prueba pide cumplir OWASP, y el almacenamiento de tokens en el navegador es donde más
seguido se falla.

## Decisión

Dos credenciales con roles distintos:

- **Access token (JWT, 10 min): solo en memoria de JavaScript.** No se guarda en `localStorage`
  ni en `sessionStorage`. Si la pestaña se recarga, se pierde y se pide uno nuevo.
- **Refresh token: cadena opaca aleatoria** en una cookie `HttpOnly; SameSite=Strict; Path=/api/v1/auth`,
  con `Secure` activable por entorno. **En la base solo se guarda su hash SHA-256**: un volcado de
  la tabla de sesiones no permite suplantar a nadie.

**Rotación en cada uso:** cada refresh invalida el token anterior y emite uno nuevo. Reusar un
refresh ya consumido es la señal de un token robado y permite cortar la sesión.

Contraseñas con **argon2id** con los parámetros mínimos que recomienda OWASP (19 MiB, 2
iteraciones), con tope de longitud en la entrada —argon2 sobre un texto enorme es un DoS barato—
y *lockout* por email+IP en Redis.

## Alternativas y por qué no

- **Access token en `localStorage`.** Es lo más cómodo y lo más explotado: cualquier XSS, propio
  o de una dependencia, lo lee en una línea. Con el token solo en memoria, un XSS tiene que
  actuar mientras la pestaña está viva y no se lleva nada persistente.
- **JWT también como refresh token.** Un JWT no se puede revocar sin una lista de revocación, que
  es justamente el estado en servidor que el JWT pretendía evitar. Un token opaco se revoca
  borrando una fila.
- **`SameSite=Lax`.** Permitiría la cookie en navegaciones de nivel superior desde otro sitio.
  Como la SPA se sirve del **mismo origen** que la API (todo pasa por el gateway en `:8080`),
  `Strict` no cuesta nada y cierra CSRF por construcción.
- **bcrypt.** Aceptable, pero argon2id es la recomendación actual de OWASP frente a ataques con
  GPU, y `@node-rs/argon2` funciona en arm64 sin compilar nada.

## Consecuencias

- **Recargar la página cuesta una petición de refresh** antes de poder pintar datos. La SPA lo
  gestiona con un estado de carga; a cambio, no hay credenciales persistentes expuestas a JS.
- Varias pestañas pueden pedir refresh a la vez; la rotación obliga a coordinarlas (resuelto en
  el cliente para que solo una renueve y las demás esperen).
- Un access token **ya emitido** sigue siendo válido hasta 10 minutos después de suspender a su
  dueño. El refresh se bloquea de inmediato vía `user.status_changed`; la *denylist* por `jti`
  para revocación instantánea queda como siguiente paso.
- La cookie limitada por `Path` no se envía a `/api/v1/users` ni al resto de la API: viaja solo
  donde hace falta.
