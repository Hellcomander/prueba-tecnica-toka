# syntax=docker/dockerfile:1.7
# Contexto de build: la raíz del monorepo (docker compose usa `context: .`).
ARG NODE_IMAGE=node:24.22.2-alpine

# deps: idéntica para todos los servicios (todos los manifests, sin scripts), así que la cache
# de esta etapa se comparte entre los builds de los 5 servicios.
FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/nest-common/package.json packages/nest-common/
COPY services/auth-service/package.json services/auth-service/
COPY services/user-service/package.json services/user-service/
COPY services/role-service/package.json services/role-service/
COPY services/audit-service/package.json services/audit-service/
COPY services/ai-agent-service/package.json services/ai-agent-service/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM deps AS build
ARG SVC=auth-service
COPY tsconfig.base.json ./
COPY packages ./packages
COPY services/${SVC} ./services/${SVC}
RUN npm run build -w services/${SVC}

# prod-deps: solo las dependencias de runtime de este servicio. Aquí sí corren los scripts de
# instalación (el motor de migraciones de Prisma y el binding nativo de argon2 para musl).
FROM deps AS prod-deps
ARG SVC=auth-service
COPY services/${SVC}/prisma services/${SVC}/prisma
COPY services/${SVC}/prisma.config.ts services/${SVC}/
RUN --mount=type=cache,target=/root/.npm npm ci -w services/${SVC} --omit=dev \
    && rm -rf services/${SVC}/src

FROM ${NODE_IMAGE} AS runtime
ARG SVC=auth-service
ENV NODE_ENV=production
WORKDIR /repo
# Se copian los directorios completos de workspace desde prod-deps (manifests, prisma/ y cualquier
# node_modules anidado que npm decida crear por conflictos de versión) y encima los dist compilados.
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/packages ./packages
COPY --from=prod-deps --chown=node:node /repo/services/${SVC} ./services/${SVC}
COPY --from=build --chown=node:node /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /repo/packages/nest-common/dist ./packages/nest-common/dist
COPY --from=build --chown=node:node /repo/services/${SVC}/dist ./services/${SVC}/dist
# Punto de montaje del volumen con el par RS256: el contenedor corre con el FS raíz de solo
# lectura y como usuario `node`, así que el directorio tiene que existir y ser suyo ANTES del
# USER (si no, el primer arranque no podría escribir la llave).
RUN mkdir -p /keys && chown node:node /keys
WORKDIR /repo/services/${SVC}
USER node
EXPOSE 3001
# Migraciones antes de arrancar: Prisma toma un advisory lock, así que varias réplicas no chocan.
# En producción correrían como un job separado y la imagen no llevaría el CLI de Prisma.
CMD ["sh", "-c", "/repo/node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
