import { CORRELATION_HEADER } from '@toka/contracts';
import axios, { type AxiosAdapter, type AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';
import { currentCorrelationId } from '../context/request-context';

export type UpstreamErrorKind = 'unavailable' | 'client_error' | 'circuit_open';

export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(
    readonly target: string,
    readonly kind: UpstreamErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpClientLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface ResilientHttpOptions {
  /** Nombre lógico del destino para logs y errores (p. ej. "role-service"). */
  name: string;
  baseURL: string;
  timeoutMs?: number;
  /** Reintentos adicionales (solo GET, que es idempotente). */
  retries?: number;
  retryBaseDelayMs?: number;
  breaker?: { volumeThreshold?: number; errorThresholdPercentage?: number; resetTimeoutMs?: number; rollingWindowMs?: number };
  logger?: HttpClientLogger;
  /** Inyectables para tests deterministas. */
  adapter?: AxiosAdapter;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface GetRequest {
  path: string;
  headers: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Cliente HTTP para llamadas servicio → servicio: timeout corto, reintentos con backoff
 * exponencial y "full jitter" (evita que todos los clientes reintenten a la vez), y un circuit
 * breaker que corta en seco cuando el destino está caído para no acumular requests colgados.
 * Los 4xx no cuentan como falla del destino (son errores del llamador) ni se reintentan.
 */
export class ResilientHttpClient {
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker<[GetRequest], unknown>;
  private readonly retries: number;
  private readonly baseDelay: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: ResilientHttpOptions) {
    this.retries = options.retries ?? 2;
    this.baseDelay = options.retryBaseDelayMs ?? 100;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.http = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 1_000,
      adapter: options.adapter,
      validateStatus: () => true,
    });
    this.breaker = new CircuitBreaker((req: GetRequest) => this.executeWithRetry(req), {
      timeout: false,
      volumeThreshold: options.breaker?.volumeThreshold ?? 5,
      errorThresholdPercentage: options.breaker?.errorThresholdPercentage ?? 50,
      resetTimeout: options.breaker?.resetTimeoutMs ?? 15_000,
      rollingCountTimeout: options.breaker?.rollingWindowMs ?? 10_000,
      errorFilter: (err: unknown) => err instanceof UpstreamError && err.kind === 'client_error',
    });
    const onState = (state: string) => () =>
      this.options.logger?.warn({ event: `breaker.${state}`, target: options.name }, `breaker.${state}`);
    this.breaker.on('open', onState('opened'));
    this.breaker.on('halfOpen', onState('half_open'));
    this.breaker.on('close', onState('closed'));
  }

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half_open';
    return 'closed';
  }

  async get<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    try {
      return (await this.breaker.fire({ path, headers })) as T;
    } catch (error) {
      if ((error as { code?: string }).code === 'EOPENBREAKER') {
        throw new UpstreamError(this.options.name, 'circuit_open', null, `${this.options.name}: circuito abierto`);
      }
      throw error;
    }
  }

  shutdown(): void {
    this.breaker.shutdown();
  }

  private async executeWithRetry(req: GetRequest): Promise<unknown> {
    let lastError: UpstreamError | undefined;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      const started = Date.now();
      try {
        const correlationId = currentCorrelationId();
        const response = await this.http.get(req.path, {
          headers: { ...req.headers, ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}) },
        });
        const status = response.status;
        this.log(req.path, status, attempt, Date.now() - started);
        if (status >= 200 && status < 300) return response.data;
        if (!RETRYABLE_STATUS.has(status)) {
          throw new UpstreamError(this.options.name, 'client_error', status, `${this.options.name} respondió ${status}`);
        }
        lastError = new UpstreamError(this.options.name, 'unavailable', status, `${this.options.name} respondió ${status}`);
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        this.log(req.path, null, attempt, Date.now() - started, error);
        lastError = new UpstreamError(this.options.name, 'unavailable', null, `${this.options.name} no respondió`);
      }
      if (attempt <= this.retries) await this.sleep(this.backoff(attempt));
    }
    throw lastError;
  }

  /** Full jitter: espera aleatoria entre 0 y base·2^(intento-1). */
  private backoff(attempt: number): number {
    return Math.round(this.random() * this.baseDelay * 2 ** (attempt - 1));
  }

  private log(path: string, status: number | null, attempt: number, durationMs: number, err?: unknown): void {
    const entry = { event: 'http.client.call', target: this.options.name, path, status, attempt, durationMs, breakerState: this.state };
    if (err || status === null || status >= 500) this.options.logger?.warn({ ...entry, err }, 'http.client.call');
    else this.options.logger?.info(entry, 'http.client.call');
  }
}
