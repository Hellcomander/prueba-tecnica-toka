interface SkeletonProps {
  className?: string;
  label?: string;
}

export function Skeleton({ className = '', label = 'Cargando contenido' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} role="status" aria-label={label} />;
}

