import { QUEUES } from '@toka/contracts';
import { declareTopology, type TopologyChannel } from './topology';

describe('declareTopology', () => {
  it('declara exchanges, cola con DLX, bindings, cola .retry con TTL que regresa a la original y .dlq', async () => {
    const calls: string[] = [];
    const channel: TopologyChannel = {
      assertExchange: async (name, type, opts) => calls.push(`exchange ${name} ${type} ${JSON.stringify(opts)}`),
      assertQueue: async (name, opts) => calls.push(`queue ${name} ${JSON.stringify(opts)}`),
      bindQueue: async (queue, exchange, pattern) => calls.push(`bind ${queue} ${exchange} ${pattern}`),
    };
    await declareTopology(channel, [QUEUES.role]);
    expect(calls).toEqual([
      'exchange toka.events topic {"durable":true}',
      'exchange toka.dlx direct {"durable":true}',
      'queue role-service.events {"durable":true,"deadLetterExchange":"toka.dlx","deadLetterRoutingKey":"role-service.events"}',
      'bind role-service.events toka.events account.registered',
      'bind role-service.events toka.events user.status_changed',
      'queue role-service.events.retry {"durable":true,"messageTtl":5000,"deadLetterExchange":"","deadLetterRoutingKey":"role-service.events"}',
      'queue role-service.events.dlq {"durable":true}',
      'bind role-service.events.dlq toka.dlx role-service.events',
    ]);
  });

  it('sin colas solo declara los exchanges (productores puros)', async () => {
    const calls: string[] = [];
    await declareTopology(
      {
        assertExchange: async (n) => calls.push(n),
        assertQueue: async (n) => calls.push(n),
        bindQueue: async (q) => calls.push(q),
      },
      [],
    );
    expect(calls).toEqual(['toka.events', 'toka.dlx']);
  });
});
