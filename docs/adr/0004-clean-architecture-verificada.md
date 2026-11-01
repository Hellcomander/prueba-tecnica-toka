# ADR 0004 · Clean Architecture con la regla de dependencias verificada en CI

**Estado:** Aceptada · **Fecha:** 2026-10-31

## Contexto

La prueba pide **DDD y Clean Architecture** en los microservicios. El riesgo conocido de ambas es
que se queden en los nombres de las carpetas: un `domain/` que importa Prisma sigue siendo un
dominio acoplado, y nadie lo nota hasta que los tests necesitan Docker para correr.

## Decisión

Cuatro capas por servicio con las dependencias apuntando **hacia adentro**:
`interface/http → application → domain ← infrastructure`.

El dominio define los **puertos** (interfaces de repositorio + un `Symbol` como token de
inyección) e `infrastructure` los implementa. Un caso de uso por clase; los controllers no tienen
lógica.

La regla **se verifica**, no se promete: `.dependency-cruiser.cjs` la ejecuta en
`npm run lint:arch` con siete reglas (`domain-is-pure`, `application-no-frameworks`,
`no-cross-service-imports`, `no-circular`…). Romper una capa es un error de CI, no un comentario
en una revisión.

**DDD táctico en dosis graduadas:** completo donde hay reglas (`auth`, `role`), ligero en `user`,
y **ninguno en `audit`**, que es un read model append-only y no tiene ni siquiera carpeta
`domain/`.

El detalle, con el código, está en
[`../ddd-clean-architecture.md`](../ddd-clean-architecture.md).

## Alternativas y por qué no

- **Servicios Nest convencionales** (`controller → service → repository`). Más rápidos de
  escribir y perfectamente razonables para un CRUD. Aquí hay invariantes que cruzan contextos
  (ADR 0005) y la prueba evalúa justamente este punto.
- **Capas solo por convención, sin verificación.** Es el escenario que se quería evitar: la
  convención se erosiona en la primera entrega con prisa, y la erosión no deja rastro en el diff.
- **DDD táctico completo en los cuatro servicios.** `audit` no tiene invariantes ni ciclo de
  vida; un agregado con constructor privado y `pullDomainEvents()` sería ceremonia sin
  beneficio. La ceremonia se justifica cuando hay algo que proteger.
- **Un paquete de dominio compartido.** Habría reintroducido el modelo único que los bounded
  contexts existen para evitar (ver [ADR 0008](0008-monorepo-con-dos-paquetes-compartidos.md)).

## Consecuencias

- **Los tests de dominio y de aplicación corren sin Docker**, con fakes en memoria que
  implementan los mismos puertos —rollback de la unidad de trabajo incluido—. Mockear Prisma,
  RabbitMQ o Redis está prohibido en el repo: un mock comprueba que llamaste al método que
  creías, no que el sistema funciona.
- **Más archivos y un mapeo extra** (fila ↔ dominio ↔ vista) por cada funcionalidad. Es el costo
  real y para un CRUD puro sería sobreingeniería.
- Las reglas de negocio se auditan leyendo dos archivos del dominio, sin recorrer controllers ni
  SQL.
- Cambiar de ORM o de store toca repositorios y mappers; no toca ninguna regla.
