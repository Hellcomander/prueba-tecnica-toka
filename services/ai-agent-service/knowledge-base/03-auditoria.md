---
title: Auditoría de accesos y cambios
requiredPermission: audit:read
---

# Auditoría de accesos y cambios

Este documento solo es visible para quien tiene el permiso `audit:read`, es decir, los roles
`admin` y `auditor`.

## Qué se registra

Todo lo que ocurre en la plataforma deja un registro: inicios de sesión correctos y fallidos,
bloqueos de cuenta, cierres de sesión, altas de cuenta, cambios de perfil, suspensiones y
reactivaciones, creación y modificación de roles, cambios de asignaciones y consultas al
asistente de IA.

El registro es **solo de adición**: no se puede modificar ni borrar una entrada. No es una
promesa del código, es un permiso de la base de datos; el usuario con el que la aplicación
escribe no tiene permiso para actualizar ni eliminar.

## Qué contiene cada entrada

Cada entrada guarda qué pasó (el tipo de evento), cuándo, quién lo originó, sobre qué o sobre
quién, y un **identificador de correlación** que permite seguir una misma acción a través de
todos los servicios que participaron en ella.

De las consultas al asistente se guarda el identificador de quien preguntó, el costo, la latencia
y si la validación de la respuesta pasó, pero **no el texto de la pregunta ni el de la
respuesta**: solo un hash de la pregunta, que permite agrupar preguntas repetidas sin almacenar
su contenido.

## Categorías

Los eventos se agrupan en cuatro categorías:

- **ACCESS**: todo lo relacionado con inicio y cierre de sesión, incluidos los intentos fallidos
  y los bloqueos.
- **CHANGE**: altas, modificaciones, suspensiones, reactivaciones y cambios de roles.
- **AI**: consultas al asistente.
- **OTHER**: el resto.

## Cómo consultarla

Se puede filtrar por tipo exacto de evento, por categoría, por quién lo originó y por rango de
fechas. Los resultados se devuelven paginados, de más reciente a más antiguo.

Los tipos más consultados son `auth.login_failed` (intentos de acceso fallidos),
`auth.account_locked` (bloqueos por intentos repetidos), `auth.login_succeeded`,
`user.status_changed` (suspensiones y reactivaciones) y `role.assignments_changed` (cambios de
permisos efectivos).

## Informe de accesos fallidos

Para revisar intentos de acceso fallidos de un periodo, se filtra por el tipo
`auth.login_failed` y el rango de fechas correspondiente. Conviene mirar dos cosas: si los
intentos se concentran en una misma cuenta (posible ataque dirigido) o se reparten entre muchas
(posible barrido), y si acabaron en un `auth.account_locked`.
