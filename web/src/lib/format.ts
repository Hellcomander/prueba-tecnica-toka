const dateTime = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

export const formatDateTime = (iso: string): string => {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? iso : dateTime.format(value);
};

/** Identificadores largos: se muestran recortados, pero siempre con el valor completo a mano. */
export const shortId = (value: string): string => (value.length > 12 ? `${value.slice(0, 8)}…` : value);

/**
 * Copia al portapapeles sin romperse donde no existe la API (contextos no seguros, jsdom).
 * Devuelve si lo consiguió para que la pantalla pueda decir la verdad en el toast.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
