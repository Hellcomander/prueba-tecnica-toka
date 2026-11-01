import { useEffect, useState } from 'react';
import { API_MODE } from '@/config';
import { DemoModeNotice, EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast-provider';
import { copyText, formatDateTime, shortId } from '@/lib/format';
import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntryView } from '@/services/audit-api';
import { EMPTY_FILTERS, useAuditStore, type AuditFilters } from '@/state/audit-store';

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  ACCESS: 'Acceso',
  CHANGE: 'Cambio',
  AI: 'IA',
  OTHER: 'Otro',
};

export function AuditPage() {
  const isReal = API_MODE === 'real';
  const status = useAuditStore((state) => state.status);
  const error = useAuditStore((state) => state.error);
  const items = useAuditStore((state) => state.items);
  const nextCursor = useAuditStore((state) => state.nextCursor);
  const loadingMore = useAuditStore((state) => state.loadingMore);
  const filters = useAuditStore((state) => state.filters);
  const stats = useAuditStore((state) => state.stats);
  const setFilters = useAuditStore((state) => state.setFilters);
  const load = useAuditStore((state) => state.load);
  const loadMore = useAuditStore((state) => state.loadMore);
  const loadStats = useAuditStore((state) => state.loadStats);

  // Los filtros del formulario son locales hasta que se aplican: cada cambio reinicia el
  // cursor y trae una página nueva, así que no conviene dispararlos tecla a tecla.
  const [draft, setDraft] = useState<AuditFilters>(filters);

  useEffect(() => {
    if (isReal) void load();
  }, [isReal, load, filters]);

  useEffect(() => {
    if (isReal) void loadStats();
  }, [isReal, loadStats]);

  const knownTypes = Object.keys(stats?.byType ?? {}).sort();
  const loading = status === 'loading';

  return (
    <div className="listing-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">TRAZABILIDAD</p>
          <h1>Auditoría</h1>
          <p className="muted">
            Eventos de acceso, cambios e IA tal como los guardó audit-service, con el envelope completo.
          </p>
        </div>
      </header>

      {!isReal ? (
        <div className="panel panel-padded">
          <DemoModeNotice section="La bitácora de auditoría" />
        </div>
      ) : (
        <>
          {stats && (
            <section className="stat-strip" aria-label="Resumen de la bitácora">
              <article className="stat-card">
                <span>EVENTOS</span>
                <strong>{stats.total}</strong>
              </article>
              <article className="stat-card">
                <span>ÚLTIMAS 24 H</span>
                <strong>{stats.last24h}</strong>
              </article>
              {AUDIT_CATEGORIES.map((category) => (
                <article className="stat-card" key={category}>
                  <span>{CATEGORY_LABELS[category].toUpperCase()}</span>
                  <strong>{stats.byCategory[category] ?? 0}</strong>
                </article>
              ))}
            </section>
          )}

          <section className="panel panel-padded">
            <form
              className="toolbar toolbar-wrap"
              onSubmit={(event) => {
                event.preventDefault();
                setFilters(draft);
              }}
            >
              <div className="field">
                <label htmlFor="audit-type">Tipo de evento</label>
                <select
                  id="audit-type"
                  value={draft.type}
                  onChange={(event) => setDraft({ ...draft, type: event.target.value })}
                >
                  <option value="">Todos</option>
                  {knownTypes.map((type) => (
                    <option value={type} key={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="audit-category">Categoría</label>
                <select
                  id="audit-category"
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                >
                  <option value="">Todas</option>
                  {AUDIT_CATEGORIES.map((category) => (
                    <option value={category} key={category}>
                      {CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="audit-actor">Actor (ID de usuario)</label>
                <input
                  id="audit-actor"
                  type="text"
                  placeholder="UUID del actor"
                  value={draft.actorId}
                  onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="audit-from">Desde</label>
                <input
                  id="audit-from"
                  type="date"
                  value={draft.from}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="audit-to">Hasta</label>
                <input
                  id="audit-to"
                  type="date"
                  value={draft.to}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              </div>
              <div className="toolbar-end">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => {
                    setDraft(EMPTY_FILTERS);
                    setFilters(EMPTY_FILTERS);
                  }}
                >
                  Limpiar
                </button>
                <button type="submit" className="button button-primary">
                  Aplicar filtros
                </button>
              </div>
            </form>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            {loading && items.length === 0 ? (
              <div className="table-loading">
                <Skeleton className="skeleton-row" label="Cargando eventos" />
                <Skeleton className="skeleton-row" label="Cargando eventos" />
                <Skeleton className="skeleton-row" label="Cargando eventos" />
              </div>
            ) : items.length === 0 && status === 'success' ? (
              <EmptyState
                title="Sin eventos para estos filtros."
                description="Prueba con un rango de fechas más amplio o quita el filtro de tipo."
              />
            ) : (
              <ul className="audit-list">
                {items.map((entry) => (
                  <AuditRow entry={entry} key={entry.eventId} />
                ))}
              </ul>
            )}

            {/* Cursor, no páginas numeradas: la bitácora solo crece y los eventos nuevos entran
                por el principio, así que un offset repetiría o se saltaría registros entre una
                petición y la siguiente. Por eso se acumula hacia abajo. */}
            <div className="load-more">
              {nextCursor ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Cargando…' : 'Cargar más'}
                </button>
              ) : (
                items.length > 0 && <span className="muted">No hay más eventos en este filtro.</span>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntryView }) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);

  async function copyCorrelation() {
    // El correlationId es el hilo que une una misma acción a través de los cinco servicios:
    // tiene que poder salir de la pantalla y entrar en una consulta de logs.
    const copied = await copyText(entry.correlationId);
    showToast(
      copied ? 'correlationId copiado.' : `No se pudo copiar; el valor es ${entry.correlationId}`,
      copied ? 'success' : 'error',
    );
  }

  return (
    <li className="audit-row">
      <div className="audit-main">
        <span className={`badge badge-${entry.category.toLowerCase()}`}>{CATEGORY_LABELS[entry.category]}</span>
        <div className="audit-copy">
          <strong>{entry.type}</strong>
          <small>
            {formatDateTime(entry.occurredAt)} · {entry.producer} · actor{' '}
            {entry.actor.id ? shortId(entry.actor.id) : entry.actor.type} · sujeto {entry.subject.type}{' '}
            {shortId(entry.subject.id)}
          </small>
        </div>
        <button
          type="button"
          className="button button-ghost"
          aria-expanded={open}
          aria-label={`${open ? 'Ocultar' : 'Ver'} el detalle del evento ${entry.type}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Ocultar' : 'Detalle'}
        </button>
      </div>
      {open && (
        <div className="audit-detail">
          <div className="audit-meta">
            <span>
              correlationId <code>{entry.correlationId}</code>
            </span>
            <button type="button" className="button button-ghost" onClick={() => void copyCorrelation()}>
              Copiar correlationId
            </button>
          </div>
          <dl className="audit-facts">
            <div>
              <dt>eventId</dt>
              <dd>{entry.eventId}</dd>
            </div>
            <div>
              <dt>causationId</dt>
              <dd>{entry.causationId ?? '—'}</dd>
            </div>
            <div>
              <dt>actor</dt>
              <dd>
                {entry.actor.type}
                {entry.actor.id ? ` · ${entry.actor.id}` : ''}
              </dd>
            </div>
            <div>
              <dt>versión</dt>
              <dd>{entry.version}</dd>
            </div>
          </dl>
          <pre className="audit-data" aria-label={`Datos del evento ${entry.type}`}>
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </div>
      )}
    </li>
  );
}
