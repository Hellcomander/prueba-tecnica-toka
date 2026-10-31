#!/bin/sh
# Crea una base de datos por servicio (DB-per-service lógico en un solo contenedor) y un usuario
# dueño por base. Desde PG15 el esquema public ya no es escribible por PUBLIC, por eso cada
# servicio es OWNER de su base. Las bases *_shadow solo las usa `prisma migrate dev` en local.
# Los valores viajan como variables de psql (:"ident" / :'literal'), nunca pegados en el SQL,
# así que una contraseña con comillas no rompe el script ni permite inyección.
# Corre una sola vez, con el volumen vacío: cambiar contraseñas después exige `docker compose down -v`.
set -eu

create_db() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v db="$1" -v shadow="${1%_db}_shadow" -v svc_user="$2" -v svc_pass="$3" <<'SQL'
CREATE ROLE :"svc_user" LOGIN PASSWORD :'svc_pass';
CREATE DATABASE :"db" OWNER :"svc_user";
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"svc_user";
CREATE DATABASE :"shadow" OWNER :"svc_user";
REVOKE CONNECT ON DATABASE :"shadow" FROM PUBLIC;
SQL
}

create_db auth_db auth_svc "${AUTH_DB_PASSWORD:?}"
create_db user_db user_svc "${USER_DB_PASSWORD:?}"
create_db role_db role_svc "${ROLE_DB_PASSWORD:?}"
