---
title: Política de accesos y roles
requiredPermission: none
---

# Política de accesos y roles

## Qué es un rol y qué es un permiso

Un **permiso** es una acción concreta sobre la plataforma, como `users:write` o `audit:read`. Un
**rol** es un conjunto de permisos con nombre. Las personas no reciben permisos sueltos: reciben
roles. Esto se hace así para que la respuesta a "¿quién puede suspender usuarios?" sea una lista
de roles corta y auditable, y no una matriz de excepciones que nadie revisa.

Los permisos existentes son ocho: `users:read`, `users:write`, `roles:read`, `roles:write`,
`roles:assign`, `audit:read`, `agent:use` y `kb:manage`.

## Roles de sistema

Hay tres roles de sistema y **no se pueden modificar ni eliminar**: cambiarlos en caliente dejaría
sin sentido cualquier auditoría anterior.

- **admin**: tiene los ocho permisos. Puede crear, editar, suspender y reactivar usuarios,
  administrar roles, asignarlos, consultar la auditoría y usar el asistente.
- **auditor**: puede consultar usuarios, roles y la auditoría completa, y usar el asistente. No
  puede modificar nada.
- **viewer**: puede consultar usuarios y roles, y usar el asistente. **No tiene acceso a la
  auditoría.** Es el rol por defecto de toda cuenta nueva.

Se pueden crear roles adicionales combinando los permisos existentes. Un rol personalizado no
puede llamarse igual que uno de sistema y necesita al menos un permiso.

## Quién puede hacer cada cosa

- **Crear un usuario**: solo `admin` (permiso `users:write`).
- **Editar el perfil de otra persona**: solo `admin`. Cualquiera puede editar el suyo.
- **Suspender o reactivar**: solo `admin`.
- **Crear, editar o eliminar roles**: solo `admin` (permiso `roles:write`).
- **Asignar roles a una persona**: solo `admin` (permiso `roles:assign`).
- **Consultar la auditoría**: `admin` y `auditor` (permiso `audit:read`).
- **Usar el asistente**: los tres roles (permiso `agent:use`).

## Reglas que la plataforma impide romper

Estas reglas no son recomendaciones: el sistema devuelve un error y la operación no ocurre.

- **No se puede dejar la plataforma sin administradores activos.** Quitar el rol `admin` al
  último administrador activo, o suspenderlo, se rechaza con el código `LAST_ADMIN`.
- **Nadie puede suspenderse a sí mismo** (`SELF_SUSPENSION`) **ni quitarse a sí mismo el rol
  admin** (`SELF_ADMIN_REMOVAL`). Evita quedarse fuera por error.
- **Un rol con usuarios asignados no se puede eliminar** (`ROLE_IN_USE`): primero hay que
  reasignar a esas personas.
- **Los roles de sistema no se modifican ni se borran** (`SYSTEM_ROLE_IMMUTABLE`).

## Principio general

El acceso se concede por rol, se revisa en la auditoría y se retira suspendiendo la cuenta. Ante
la duda, el rol correcto es el de menos permisos que permita a la persona hacer su trabajo.
