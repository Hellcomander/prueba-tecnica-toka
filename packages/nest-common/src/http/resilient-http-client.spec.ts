import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { ClsServiceManager } from 'nestjs-cls';
import { CLS_CORRELATION_ID } from '../context/request-context';
import { ResilientHttpClient, UpstreamError } from './resilient-http-client';

type Step = number | 'network-error';

/** Adapter de axios que responde una secuencia programada y registra cada request. */
function scriptedAdapter(steps: Step[]) {
  const requests: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    requests.push(config);
    const step = steps.length > 1 ? steps.shift()! : steps[0];
    if (step === 'network-error') throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { data: { ok: true, status: step }, status: step, statusText: '', headers: {}, config };
  };
  return { adapter, requests };
}

const logs: { level: string; obj: object }[] = [];
const logger = { info: (obj: object) => logs.push({ level: 'info', obj }), warn: (obj: object) => logs.push({ level: 'warn', obj }) };

function client(steps: Step[], extra: Partial<ConstructorParameters<typeof ResilientHttpClient>[0]> = {}) {
  const { adapter, requests } = scriptedAdapter(steps);
  const sleeps: number[] = [];
  const c = new ResilientHttpClient({
    name: 'role-service',
    baseURL: 'http://role-service:3003',
    adapter,
    logger,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, requests, sleeps };
}

describe('ResilientHttpClient', () => {
  afterEach(() => {
    logs.length = 0;
  });

  it('devuelve el cuerpo en 2xx y propaga el correlation-id del contexto', async () => {
    const { c, requests } = client([200]);
    const cls = ClsServiceManager.getClsService();
    const data = await cls.run(async () => {
      cls.set(CLS_CORRELATION_ID, 'corr-12345678');
      return c.get<{ ok: boolean }>('/internal/v1/authorizations/u1', { authorization: 'Bearer t' });
    });
    expect(data).toEqual({ ok: true, status: 200 });
    expect(requests[0].headers['x-correlation-id']).toBe('corr-12345678');
    expect(requests[0].headers.authorization).toBe('Bearer t');
    expect(logs[0]).toMatchObject({ level: 'info', obj: { event: 'http.client.call', target: 'role-service', status: 200, attempt: 1 } });
    c.shutdown();
  });

  it('reintenta 503 y errores de red con backoff exponencial con jitter, y luego responde', async () => {
    const { c, requests, sleeps } = client([503, 'network-error', 200], { retryBaseDelayMs: 100 });
    await expect(c.get('/x')).resolves.toEqual({ ok: true, status: 200 });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]); // random 0.5 × 100·2^0 y 0.5 × 100·2^1
    c.shutdown();
  });

  it('agotados los reintentos lanza UpstreamError "unavailable"', async () => {
    const { c, requests } = client([503], { retries: 2 });
    await expect(c.get('/x')).rejects.toMatchObject({ kind: 'unavailable', status: 503, target: 'role-service' });
    expect(requests).toHaveLength(3);
    c.shutdown();
  });

  it('un 4xx no se reintenta ni cuenta para el breaker', async () => {
    const { c, requests } = client([404], { breaker: { volumeThreshold: 1, errorThresholdPercentage: 1 } });
    for (let i = 0; i < 3; i++) await expect(c.get('/x')).rejects.toMatchObject({ kind: 'client_error', status: 404 });
    expect(requests).toHaveLength(3);
    expect(c.state).toBe('closed');
    c.shutdown();
  });

  it('el breaker se abre tras fallas repetidas y corta en seco sin llamar al destino', async () => {
    const { c, requests } = client(['network-error'], { retries: 0, breaker: { volumeThreshold: 2, errorThresholdPercentage: 50, resetTimeoutMs: 60_000 } });
    await expect(c.get('/x')).rejects.toBeInstanceOf(UpstreamError);
    await expect(c.get('/x')).rejects.toBeInstanceOf(UpstreamError);
    expect(c.state).toBe('open');
    const before = requests.length;
    await expect(c.get('/x')).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(requests.length).toBe(before);
    expect(logs.some((l) => (l.obj as { event?: string }).event === 'breaker.opened')).toBe(true);
    c.shutdown();
  });
});
