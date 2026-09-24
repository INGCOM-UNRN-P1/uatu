/**
 * Utilidades de tiempo UTC.
 */

/** Parsea una marca ISO-8601 UTC estricta (con sufijo Z u offset explícito). */
export function parseUtc(value: string, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`El campo ${field} debe ser una fecha ISO-8601 con zona horaria explícita (recibido: ${String(value)}).`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`El campo ${field} contiene una fecha inválida: ${value}.`);
  }
  return date;
}

/** Formatea la hora como HH:mm en UTC. */
export function formatHourMinuteUtc(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Marca temporal ISO-8601 con milisegundos y sufijo Z. */
export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Abstracción de reloj inyectable (facilita pruebas y corrección de desfase). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
