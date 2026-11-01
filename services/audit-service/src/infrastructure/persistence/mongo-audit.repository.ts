import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { AuditCategory } from '@toka/contracts';
import { type Model, Schema } from 'mongoose';
import type { AuditEntry, AuditFilter, AuditRepository, AuditStatsSnapshot } from '../../application/ports';
import { buildMongoFilter, READ_ORDER } from './mongo-filter';

/** Forma del documento en `audit_entries`: `_id` es el `eventId`. */
export interface AuditEntryDocument {
  _id: string;
  type: string;
  category: AuditCategory;
  version: number;
  occurredAt: Date;
  producer: string;
  correlationId: string;
  causationId: string | null;
  actor: { id: string | null; type: 'user' | 'service' | 'system' };
  subject: { type: string; id: string };
  data: unknown;
}

/**
 * Colección `audit_entries`. La crea y la indexa `infra/mongo/init/01-audit.js` (el usuario de la
 * app no puede): por eso `autoCreate` y `autoIndex` van en false. `minimize: false` conserva
 * `data: {}`; `versionKey: false` evita el `__v` (nunca se actualiza nada).
 */
export const AuditEntrySchema = new Schema<AuditEntryDocument>(
  {
    _id: { type: String, required: true },
    type: { type: String, required: true },
    category: { type: String, required: true },
    version: { type: Number, required: true },
    occurredAt: { type: Date, required: true },
    producer: { type: String, required: true },
    correlationId: { type: String, required: true },
    causationId: { type: String, default: null },
    actor: {
      type: new Schema({ id: { type: String, default: null }, type: { type: String, required: true } }, { _id: false }),
      required: true,
    },
    subject: {
      type: new Schema({ type: { type: String, required: true }, id: { type: String, required: true } }, { _id: false }),
      required: true,
    },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { collection: 'audit_entries', _id: false, versionKey: false, autoCreate: false, autoIndex: false, minimize: false },
);

export const AUDIT_MODEL = 'AuditEntry';

const DUPLICATE_KEY = 11000;
const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | null)?.code === DUPLICATE_KEY;

type Row = AuditEntryDocument;

const toEntry = (row: Row): AuditEntry => ({
  eventId: row._id,
  type: row.type,
  category: row.category,
  version: row.version,
  occurredAt: row.occurredAt,
  producer: row.producer,
  correlationId: row.correlationId,
  causationId: row.causationId ?? null,
  actor: row.actor,
  subject: row.subject,
  data: row.data,
});

/** Adaptador Mongoose. Solo `insertOne`, `find` y `aggregate`: nunca update ni delete. */
@Injectable()
export class MongoAuditRepository implements AuditRepository {
  constructor(@InjectModel(AUDIT_MODEL) private readonly model: Model<AuditEntryDocument>) {}

  async append(entry: AuditEntry): Promise<boolean> {
    const { eventId, ...rest } = entry;
    try {
      await this.model.insertOne({ _id: eventId, ...rest });
      return true;
    } catch (error) {
      // Re-entrega del broker: la entrada ya existe. Se ignora (idempotencia por diseño).
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  async find(filter: AuditFilter, limit: number): Promise<AuditEntry[]> {
    const rows = await this.model.find(buildMongoFilter(filter)).sort(READ_ORDER).limit(limit).lean<Row[]>();
    return rows.map(toEntry);
  }

  async stats(since: Date): Promise<AuditStatsSnapshot> {
    const [facets] = await this.model.aggregate<{
      total: { n: number }[];
      last: { n: number }[];
      byCategory: { _id: string; n: number }[];
      byType: { _id: string; n: number }[];
    }>([
      {
        $facet: {
          total: [{ $count: 'n' }],
          last: [{ $match: { occurredAt: { $gte: since } } }, { $count: 'n' }],
          byCategory: [{ $group: { _id: '$category', n: { $sum: 1 } } }],
          byType: [{ $group: { _id: '$type', n: { $sum: 1 } } }],
        },
      },
    ]);
    const counts = (rows: { _id: string; n: number }[] = []) => Object.fromEntries(rows.map((r) => [r._id, r.n]));
    return {
      total: facets?.total[0]?.n ?? 0,
      last24h: facets?.last[0]?.n ?? 0,
      byCategory: counts(facets?.byCategory),
      byType: counts(facets?.byType),
    };
  }
}
