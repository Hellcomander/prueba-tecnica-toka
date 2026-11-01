# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/nest-common/package.json packages/nest-common/
COPY services/auth-service/package.json services/auth-service/
COPY services/user-service/package.json services/user-service/
COPY services/role-service/package.json services/role-service/
COPY services/audit-service/package.json services/audit-service/
COPY services/ai-agent-service/package.json services/ai-agent-service/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY packages/contracts/src packages/contracts/src
COPY web web
ARG VITE_API_MODE=mock
ENV VITE_API_MODE=${VITE_API_MODE}
RUN npm run build --workspace @toka/web

FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /repo/web/dist /usr/share/nginx/html
EXPOSE 8080
