import type { Actor, EventData, EventType, Subject } from '@toka/contracts';
import type { UserStats } from './queries/read-model';

/** Ejecuta `work` en una transacción: todo lo que hagan los repositorios adentro se confirma junto. */
export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface OutboundEvent<T extends EventType = EventType> {
  type: T;
  subject: Subject;
  data: EventData<T>;
  actor: Actor;
}

/** Publica eventos de integración. Se llama DESPUÉS del commit: nunca se anuncia algo que no se guardó. */
export interface EventBus {
  publish(events: OutboundEvent[]): Promise<void>;
}

/** Idempotencia de consumidores: false si el evento ya se procesó (at-least-once). */
export interface ProcessedEvents {
  markProcessed(eventId: string, type: string): Promise<boolean>;
}

/**
 * Cache de las estadísticas del dashboard (Redis). Es solo un acelerador: si falla, el adaptador
 * degrada a "miss" y nunca propaga el error, así que el servicio no depende de Redis para responder.
 */
export interface StatsCache {
  get(): Promise<UserStats | null>;
  set(stats: UserStats): Promise<void>;
  invalidate(): Promise<void>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const EVENT_BUS = Symbol('EVENT_BUS');
export const PROCESSED_EVENTS = Symbol('PROCESSED_EVENTS');
export const STATS_CACHE = Symbol('STATS_CACHE');
