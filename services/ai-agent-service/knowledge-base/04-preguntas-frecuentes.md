---
title: Preguntas frecuentes
requiredPermission: none
---

# Preguntas frecuentes

## No puedo entrar y mi contraseña es correcta

Hay tres causas posibles y se distinguen fácil. Si el mensaje habla de demasiados intentos, es un
**bloqueo temporal**: se levanta solo en unos minutos. Si el acceso se rechaza sin más, puede
que la cuenta esté **suspendida**: eso lo levanta un administrador. Si el problema aparece justo
después de cambiar de rol, la sesión puede estar usando permisos antiguos; cerrar sesión y volver
a entrar los actualiza.

## Cambiaron mis permisos y la aplicación sigue como antes

Los permisos viajan dentro del token de sesión, que se renueva cada diez minutos. Un cambio de
rol tarda **hasta diez minutos** en reflejarse. Cerrar sesión y volver a entrar lo aplica de
inmediato.

## ¿Por qué no veo la sección de auditoría?

Porque requiere el permiso `audit:read`, que tienen los roles `admin` y `auditor`. El rol
`viewer` no lo tiene.

## Acabo de crear un usuario y no aparece en el directorio

El alta se propaga en segundos. Si tras recargar sigue sin aparecer, es un problema real y
conviene reportarlo; crear la cuenta otra vez no lo arregla y dará error de correo duplicado.

## ¿Se pueden borrar usuarios?

No. Las cuentas se **suspenden**, no se borran, porque su historial forma parte de la auditoría.
Una cuenta suspendida no puede entrar y sigue apareciendo en el directorio con ese estado.

## ¿Qué puede hacer el asistente?

Puede responder sobre las políticas de esta base de conocimiento y consultar datos en vivo de la
plataforma: usuarios, roles y auditoría. **Solo lee.** No puede crear, modificar ni suspender
nada, y solo ve lo que vería quien pregunta: si alguien sin permiso de auditoría le pide eventos
de auditoría, no los obtiene.

## El asistente dice que no sabe algo

Es su comportamiento esperado cuando la respuesta no está en la base de conocimiento ni puede
consultarla. Es preferible a que invente un dato que parezca correcto.

## ¿Puedo cambiar mi nombre o mi área?

Sí, cualquiera puede editar su propio perfil. Para cambiar el de otra persona hace falta el rol
`admin`.
