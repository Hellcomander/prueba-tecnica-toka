import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ResilientHttpClient, UpstreamError } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { TOOLS_BY_NAME, type ToolDefinition } from '../../application/tools/catalog';
import type { ToolGateway, ToolInvocation } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { ENV, type Env } from '../config/env';

/**
 * Ejecuta las herramientas contra los microservicios, por la red interna de Docker.
 *
 * La decisión central: **se reenvía el token del usuario tal cual**, no un token de servicio del
 * agente. Un token de servicio con permiso de lectura sobre todo convertiría al agente en el
 * único punto donde se decide qué puede ver cada quién — y un fallo ahí sería total y silencioso.
 * Reenviando el JWT del usuario, `user`, `role` y `audit` vuelven a autorizar cada llamada con
 * sus guards de siempre: **el agente no puede ver nada que el usuario no pudiera ver por sí
 * mismo**, ni siquiera si el modelo se dejara convencer por una inyección.
 *
 * Los clientes son los mismos `ResilientHttpClient` del resto del repo (timeout, reintentos con
 * jitter y circuit breaker), con un plazo más holgado que el de S1 porque aquí el usuario ya
 * está esperando a un modelo de lenguaje.
 */
@Injectable()
export class HttpToolGateway implements ToolGateway, OnApplicationShutdown {
  private readonly clients: Record<ToolDefinition['target'], ResilientHttpClient>;

  constructor(
    @Inject(ENV) env: Env,
    @InjectPinoLogger(HttpToolGateway.name) logger: PinoLogger,
  ) {
    const common = {
      timeoutMs: env.TOOL_TIMEOUT_MS,
      retries: 1,
      logger: { info: (obj: object, msg: string) => logger.info(obj, msg), warn: (obj: object, msg: string) => logger.warn(obj, msg) },
    };
    this.clients = {
      user: new ResilientHttpClient({ name: 'user-service', baseURL: env.USER_SERVICE_URL, ...common }),
      role: new ResilientHttpClient({ name: 'role-service', baseURL: env.ROLE_SERVICE_URL, ...common }),
      audit: new ResilientHttpClient({ name: 'audit-service', baseURL: env.AUDIT_SERVICE_URL, ...common }),
    };
  }

  async invoke({ name, args, accessToken }: ToolInvocation): Promise<unknown> {
    const definition = TOOLS_BY_NAME.get(name);
    if (!definition) throw new DomainError('UNKNOWN_TOOL', 'not_found', `La herramienta ${name} no existe`);

    const path = buildPath(definition, args);
    try {
      return await this.clients[definition.target].get(path, { authorization: `Bearer ${accessToken}` });
    } catch (error) {
      if (error instanceof UpstreamError) {
        // El 403 se distingue del resto: es información útil para el usuario ("no tienes
        // permiso"), no una avería del sistema.
        if (error.status === 403) throw new DomainError('TOOL_FORBIDDEN', 'forbidden', 'No tienes permiso para consultar ese dato');
        if (error.status === 404) throw new DomainError('TOOL_NOT_FOUND', 'not_found', 'No encontré ese registro');
        throw new DomainError('TOOL_UNAVAILABLE', 'unavailable', `${error.target} no respondió`);
      }
      throw error;
    }
  }

  onApplicationShutdown(): void {
    for (const client of Object.values(this.clients)) client.shutdown();
  }
}

/**
 * Construye la ruta desde la definición, no desde lo que diga el modelo: los parámetros de
 * camino se codifican y los de query se filtran contra la lista blanca de la herramienta. Un
 * argumento que el modelo invente y no esté declarado simplemente no viaja.
 */
export function buildPath(definition: ToolDefinition, args: Record<string, unknown>): string {
  const path = definition.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      throw new DomainError('TOOL_ARGUMENT_MISSING', 'validation', `Falta el parámetro ${key} para ${definition.schema.name}`);
    }
    return encodeURIComponent(String(value));
  });
  const query = new URLSearchParams();
  for (const key of definition.queryParams) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
