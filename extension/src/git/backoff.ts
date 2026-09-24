/**
 * Backoff exponencial con jitter (Sección 6.3):
 *
 *   T_wait = min(T_max, T_base * 2^attempt) * Uniform(0.8, 1.2)
 */

export const BACKOFF_BASE_MS = 2_000;

export function computeBackoffMs(
  attempt: number,
  maxMs: number,
  random: () => number = Math.random,
  baseMs: number = BACKOFF_BASE_MS
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + 0.4 * random();
  return Math.round(exp * jitter);
}
