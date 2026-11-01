import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/toast-provider';
import { auditApi, type AuditEntryView } from '@/services/audit-api';
import { useAuthStore } from '@/state/auth-store';
import { useAuditStore } from '@/state/audit-store';
import { AuditPage } from './audit-page';

jest.mock('@/config', () => ({ API_MODE: 'real' }));
jest.mock('@/services/audit-api', () => {
  const actual = jest.requireActual('@/services/audit-api');
  return { ...actual, auditApi: { list: jest.fn(), stats: jest.fn() } };
});

const audit = auditApi as jest.Mocked<typeof auditApi>;

const entry = (id: string, type: string): AuditEntryView => ({
  eventId: id,
  type,
  category: 'ACCESS',
  version: 1,
  occurredAt: '2026-10-30T12:00:00.000Z',
  producer: 'auth-service',
  correlationId: `corr-${id}`,
  causationId: null,
  actor: { id: 'user-ana', type: 'user' },
  subject: { type: 'user', id: 'user-ana' },
  data: { userId: 'user-ana', ip: '172.19.0.1' },
});

function renderAudit() {
  useAuthStore
    .getState()
    .setSession(
      { id: 'me', email: 'auditor@toka.local', fullName: 'Aldo Auditor', roles: ['auditor'], permissions: ['audit:read'] },
      'token',
    );
  return render(
    <ToastProvider>
      <AuditPage />
    </ToastProvider>,
  );
}

describe('página de auditoría', () => {
  beforeEach(() => {
    useAuditStore.getState().reset();
    useAuthStore.getState().clearSession();
    audit.stats.mockResolvedValue({
      total: 2,
      last24h: 2,
      byCategory: { ACCESS: 2, CHANGE: 0, AI: 0, OTHER: 0 },
      byType: { 'auth.login_succeeded': 2 },
    });
    audit.list.mockResolvedValue({ items: [entry('ev-1', 'auth.login_succeeded')], nextCursor: 'cursor-1' });
  });

  it('acumula las páginas por cursor en vez de reemplazarlas', async () => {
    const user = userEvent.setup();
    renderAudit();
    // Se ancla en el botón de la fila: el tipo también aparece como opción del filtro.
    expect(await screen.findByRole('button', { name: /detalle del evento auth.login_succeeded/ })).toBeInTheDocument();

    audit.list.mockResolvedValue({ items: [entry('ev-2', 'auth.logout')], nextCursor: null });
    await user.click(screen.getByRole('button', { name: 'Cargar más' }));

    // La segunda página se pide con el cursor que trajo la primera, no con un offset.
    await waitFor(() =>
      expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1' })),
    );
    expect(await screen.findByText('auth.logout')).toBeInTheDocument();
    // La primera página sigue en pantalla: el cursor acumula, no reemplaza.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('deja de ofrecer Cargar más cuando el servidor devuelve nextCursor null', async () => {
    audit.list.mockResolvedValue({ items: [entry('ev-1', 'auth.login_succeeded')], nextCursor: null });
    renderAudit();
    await screen.findByRole('button', { name: /detalle del evento auth.login_succeeded/ });

    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
    expect(screen.getByText('No hay más eventos en este filtro.')).toBeInTheDocument();
  });

  it('aplica los filtros, convierte las fechas a instantes y reinicia el cursor', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByRole('button', { name: /detalle del evento auth.login_succeeded/ });

    await user.selectOptions(screen.getByLabelText('Categoría'), 'CHANGE');
    await user.type(screen.getByLabelText('Actor (ID de usuario)'), 'user-ana');
    await user.type(screen.getByLabelText('Desde'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Aplicar filtros' }));

    await waitFor(() =>
      expect(audit.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'CHANGE', actorId: 'user-ana' }),
      ),
    );

    // El día elegido se interpreta en la zona de quien mira, no en UTC: el instante enviado
    // debe ser la medianoche LOCAL del 1 de octubre. Enviarlo como '…T00:00:00.000Z' hacía que
    // alguien en Ciudad de México recibiera eventos desde las 18:00 del día anterior.
    const sent = new Date(audit.list.mock.calls.at(-1)?.[0].from as string);
    expect([sent.getFullYear(), sent.getMonth(), sent.getDate()]).toEqual([2026, 9, 1]);
    expect([sent.getHours(), sent.getMinutes(), sent.getSeconds()]).toEqual([0, 0, 0]);
    // El cursor pertenecía al listado anterior: la consulta filtrada empieza de cero.
    expect(audit.list.mock.calls.at(-1)?.[0].cursor).toBeUndefined();
  });

  it('muestra el correlationId y el data crudo solo cuando se piden', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByRole('button', { name: /detalle del evento auth.login_succeeded/ });

    expect(screen.queryByText('corr-ev-1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ver el detalle del evento/ }));

    expect(await screen.findByText('corr-ev-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Datos del evento auth.login_succeeded')).toHaveTextContent('172.19.0.1');
    expect(screen.getByRole('button', { name: 'Copiar correlationId' })).toBeInTheDocument();
  });
});
