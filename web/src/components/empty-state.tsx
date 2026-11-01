interface EmptyStateProps {
  title: string;
  description: string;
  symbol?: string;
}

export function EmptyState({ title, description, symbol = '○' }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-symbol" aria-hidden="true">
        {symbol}
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

/**
 * En modo demo no hay backend detrás: el login se resuelve en el navegador con los usuarios
 * semilla, pero estas pantallas leen datos reales. Se dice con claridad en vez de inventar
 * registros falsos, que harían creer que la integración funciona cuando no se ha probado.
 */
export function DemoModeNotice({ section }: { section: string }) {
  return (
    <EmptyState
      symbol="◌"
      title={`${section} necesita el backend.`}
      description="La SPA está en modo demostración. Levanta el stack con docker compose up y abre la aplicación en el gateway, o arranca el front con VITE_API_MODE=real."
    />
  );
}
