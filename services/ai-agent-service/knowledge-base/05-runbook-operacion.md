---
title: Runbook de operación
requiredPermission: users:write
---

# Runbook de operación

Procedimientos para quien administra la plataforma. Requiere permiso `users:write`.

## Retirar el acceso a alguien que deja la organización

1. Suspender su cuenta desde el directorio de usuarios.
2. Verificar en la auditoría que aparece el evento `user.status_changed` con el nuevo estado.
3. Tener en cuenta que su sesión actual sigue siendo válida **hasta diez minutos**. Si el caso
   es urgente, avisar a seguridad: suspender no corta una sesión ya abierta de forma inmediata.
4. No eliminar la cuenta: el historial se conserva a propósito.

## Dar de alta a alguien

1. Crear la cuenta con su correo corporativo. Recibe el rol `viewer` por defecto.
2. Esperar unos segundos y comprobar que aparece en el directorio.
3. Asignarle el rol que corresponda a su trabajo, no el más cómodo.
4. Si necesita permisos que ningún rol existente reúne, crear un rol nuevo con esos permisos en
   lugar de darle `admin`.

## "No se puede quitar el último administrador" (LAST_ADMIN)

La plataforma rechaza la operación porque dejaría la organización sin administradores activos.
Es correcto. El procedimiento es al revés: primero dar el rol `admin` a la persona que va a
sustituir, comprobar que puede entrar, y después retirar el rol a la anterior.

## Revisar accesos fallidos

Filtrar la auditoría por el tipo `auth.login_failed` en el rango de fechas a revisar. Señales de
alerta: muchos intentos sobre una misma cuenta en pocos minutos, intentos sobre cuentas que ya no
existen, o un `auth.account_locked` que la persona afectada no reconoce.

## Revisión periódica de permisos

Cada trimestre conviene listar quién tiene el rol `admin` y confirmar que sigue haciendo falta.
Los permisos se acumulan si nadie los revisa.

## Si el asistente no responde

El asistente puede degradar en escalones: si el modelo principal no responde, usa uno de
respaldo; si ninguno responde, devuelve los pasajes relevantes de la base de conocimiento sin
redactar. Si tampoco hay pasajes, responde que no está disponible. Un asistente degradado no
afecta al resto de la plataforma: iniciar sesión, consultar usuarios y revisar la auditoría
siguen funcionando con normalidad.
