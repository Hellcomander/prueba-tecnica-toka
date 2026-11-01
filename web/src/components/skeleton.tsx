interface SkeletonProps {
  className?: string;
  label?: string;
}

export function Skeleton({ className = '', label = 'Cargando contenido' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} role="status" aria-label={label} />;
}

export function PageSkeleton() {
  return (
    <section className="skeleton-page" aria-label="Cargando página">
      <Skeleton className="skeleton-title" />
      <div className="skeleton-cards">
        <Skeleton className="skeleton-card" />
        <Skeleton className="skeleton-card" />
        <Skeleton className="skeleton-card" />
      </div>
      <Skeleton className="skeleton-table" />
    </section>
  );
}
