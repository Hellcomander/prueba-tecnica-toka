# ADR 0005 · Invariantes entre contextos con proyecciones locales por eventos

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

Dos reglas del negocio necesitan datos de **dos** bounded contexts a la vez:

> No se puede quitar el rol `admin` ni suspender **al último administrador activo**.

"Administrador" vive en `role` (las asignaciones); "activo" vive en `user` (el estado del
usuario). Con una sola base sería un `JOIN`. Con bases separadas, no.

## Decisión

Cada lado mantiene una **proyección local** alimentada por eventos, y la regla se evalúa **sin
ninguna llamada síncrona**:

- `role-service` guarda `user_directory(userId, status, version)` desde `account.registered` y
  `user.status_changed`. Al quitar el rol `admin` cuenta los admins **activos** restantes; si
  quedaría cero, responde **409 `LAST_ADMIN`**.
- `user-service` guarda `user_roles_view(userId, roles[], assignmentsVersion)` desde el snapshot
  de `role.assignments_changed`. Al suspender a un admin hace el conteo equivalente.

Dentro de cada servicio la invariante **sí** se serializa de verdad: el caso de uso toma
`lockMembership(adminRoleId)` (un `SELECT … FOR UPDATE` sobre la fila del rol) antes de contar,
para que dos transacciones concurrentes en el mismo servicio no pasen ambas el chequeo.

Además: **nadie se suspende a sí mismo ni se quita a sí mismo el rol `admin`**, comparando con el
`sub` del token y verificando contra la base propia, no contra el claim.

## Alternativas y por qué no

- **Que `user` llame a `role` por REST al suspender.** Añade acoplamiento en disponibilidad justo
  donde más duele (no podrías suspender a nadie con `role` caído) y una llamada síncrona más al
  camino crítico, exactamente lo que [ADR 0006](0006-una-sola-llamada-sincrona-que-falla-cerrado.md)
  limita a un solo caso.
- **Un servicio único dueño de la invariante** (o una saga con compensación). Es la respuesta
  correcta cuando la regla es crítica y la concurrencia alta. Aquí añade un contexto nuevo y
  compensaciones para una operación de administración que ocurre unas pocas veces por semana.
- **Un lock distribuido en Redis** para serializar entre servicios. Cierra la ventana, pero
  convierte a Redis en dependencia de corrección —no solo de rendimiento— de una operación de
  escritura. Para este volumen no se justifica; sería el siguiente paso si el dominio cambiara.

## Consecuencias

- **Queda una ventana de carrera entre servicios, y se documenta en vez de disimularse:** dos
  admins que se suspenden mutuamente en el mismo instante podrían pasar ambos chequeos. Las
  proyecciones son eventualmente consistentes (normalmente milisegundos) y la recuperación es
  volver a correr el *seed* del admin.
- La misma proyección `user_roles_view` sirve para **filtrar usuarios por rol sin llamar a
  `role`** (CQRS): la inversión en la proyección se paga dos veces.
- Las proyecciones llevan `version` y descartan eventos viejos que lleguen desordenados, así que
  el orden de entrega no las corrompe.
- Hay datos duplicados a propósito. Es la contrapartida natural de separar contextos: se cambia
  normalización por autonomía.
