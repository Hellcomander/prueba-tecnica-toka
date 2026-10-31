// Corre una sola vez, cuando el volumen de Mongo está vacío (docker-entrypoint-initdb.d).
// Mínimo privilegio: audit-service solo puede leer, insertar y crear índices en audit_entries.
// La colección y los índices se crean aquí; Mongoose corre con autoCreate/autoIndex en false.
const dbName = process.env.MONGO_AUDIT_DB || 'audit_db';
const user = process.env.MONGO_AUDIT_USER || 'audit_svc';
const pass = process.env.MONGO_AUDIT_PASSWORD;
if (!pass) throw new Error('MONGO_AUDIT_PASSWORD es obligatorio');

const audit = db.getSiblingDB(dbName);

audit.createRole({
  role: 'auditAppendOnly',
  privileges: [
    {
      resource: { db: dbName, collection: 'audit_entries' },
      actions: ['find', 'insert', 'createIndex', 'listIndexes'],
    },
    { resource: { db: dbName, collection: '' }, actions: ['listCollections'] },
  ],
  roles: [],
});

audit.createUser({ user, pwd: pass, roles: [{ role: 'auditAppendOnly', db: dbName }] });

audit.createCollection('audit_entries');
audit.audit_entries.createIndexes([
  { occurredAt: -1, _id: -1 },
  { type: 1, occurredAt: -1 },
  { category: 1, occurredAt: -1 },
  { 'actor.id': 1, occurredAt: -1 },
  { 'subject.id': 1 },
  { correlationId: 1 },
]);
