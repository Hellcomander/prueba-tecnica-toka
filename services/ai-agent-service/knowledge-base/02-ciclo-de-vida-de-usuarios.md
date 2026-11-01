---
title: Ciclo de vida de una cuenta
requiredPermission: none
---

# Ciclo de vida de una cuenta

## Alta

Un administrador crea la cuenta con el correo y el nombre de la persona. A partir de ahí, y sin
que nadie más intervenga, ocurren tres cosas: se crea su **perfil** en el directorio, se le
asigna el rol **viewer** por defecto y el alta queda registrada en la **auditoría**.

Esas tres cosas no son instantáneas: pasan en segundos, no en el mismo milisegundo. Si alguien
consulta el directorio justo después de crear la cuenta y todavía no ve el perfil, la respuesta
correcta es esperar unos segundos y volver a consultar, no crear la cuenta otra vez.

El correo es único en toda la plataforma. Intentar crear una cuenta con un correo que ya existe
se rechaza.

## Estados

Una cuenta está **activa** o **suspendida**. No hay estados intermedios ni borrado de cuentas:
el historial de una persona que estuvo en la organización forma parte de la auditoría y no se
elimina.

## Suspensión

Suspender es la forma de retirar el acceso. Efectos inmediatos:

- La persona **no puede iniciar sesión**.
- **No puede renovar su sesión**: si tenía una abierta, deja de poder prolongarla.
- Su sesión activa deja de funcionar en **como mucho diez minutos**, que es lo que dura un token
  de acceso. No es instantáneo y es importante saberlo: para un incidente de seguridad grave,
  suspender no sustituye a cerrar la sesión.
- Sus datos y su historial se conservan.

No se puede suspender a quien dejaría la plataforma sin administradores activos, ni a uno mismo.

## Reactivación

Un administrador reactiva la cuenta y la persona vuelve a poder iniciar sesión con la misma
contraseña y los mismos roles que tenía. La reactivación también queda auditada.

## Bloqueo por intentos fallidos

El bloqueo por contraseñas equivocadas es **distinto** de la suspensión: es automático, temporal
y se levanta solo pasados unos minutos. Que alguien no pueda entrar no significa que su cuenta
esté suspendida; conviene comprobar cuál de las dos cosas está pasando antes de actuar.

## Contraseñas y sesiones

- La contraseña se guarda cifrada con argon2id y no es recuperable: solo se puede cambiar.
- La sesión se renueva automáticamente mientras se usa la plataforma; el token de renovación
  cambia en cada uso.
- Cerrar sesión invalida la sesión en el servidor, no solo en el navegador.
