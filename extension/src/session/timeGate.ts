import { Clock } from '../core/time';

/**
 * Puerta temporal de activación (Sección 3.1): T_start <= T_now <= T_deadline.
 */

export type TimePhase = 'STANDBY' | 'ACTIVE' | 'CONCLUDED';

export function computeTimePhase(nowMs: number, startMs: number, deadlineMs: number): TimePhase {
  if (nowMs < startMs) {
    return 'STANDBY';
  }
  if (nowMs <= deadlineMs) {
    return 'ACTIVE';
  }
  return 'CONCLUDED';
}

/** Máximo retardo admitido por setTimeout (~24,8 días). */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

/**
 * Observa el reloj y notifica cada transición de fase. Agenda un
 * temporizador exacto hacia el próximo límite (start_utc o deadline_utc)
 * y, además, reevalúa periódicamente para tolerar suspensiones del equipo
 * o saltos del reloj del sistema.
 */
export class TimeGate {
  private phase: TimePhase | undefined;
  private timer: unknown;
  private poller: unknown;

  constructor(
    private readonly clock: Clock,
    private readonly startMs: number,
    private readonly deadlineMs: number,
    private readonly onTransition: (phase: TimePhase, previous: TimePhase | undefined) => void,
    private readonly timers: TimerApi = nodeTimers,
    private readonly pollIntervalMs = 15_000
  ) {}

  public get current(): TimePhase {
    return this.phase ?? computeTimePhase(this.clock.now(), this.startMs, this.deadlineMs);
  }

  public start(): void {
    this.evaluate();
    this.poller = this.timers.setInterval(() => this.evaluate(), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.poller !== undefined) {
      this.timers.clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  /** Reevalúa la fase actual y reagenda el temporizador del próximo límite. */
  public evaluate(): void {
    const now = this.clock.now();
    const next = computeTimePhase(now, this.startMs, this.deadlineMs);
    const previous = this.phase;
    if (next !== previous) {
      this.phase = next;
      this.onTransition(next, previous);
    }
    this.schedule(now);
  }

  private schedule(now: number): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    let boundary: number | undefined;
    if (this.phase === 'STANDBY') {
      boundary = this.startMs;
    } else if (this.phase === 'ACTIVE') {
      boundary = this.deadlineMs + 1;
    }
    if (boundary === undefined) {
      return;
    }
    const delay = Math.min(Math.max(boundary - now, 0), MAX_TIMER_DELAY_MS);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.evaluate();
    }, delay);
  }
}

/**
 * Reloj corregido contra una fuente de tiempo confiable (cabecera HTTP Date
 * del registro de claves). Mitiga la manipulación del reloj local.
 */
export class TrustedClock implements Clock {
  private offsetMs = 0;
  private source: 'local' | 'http-date' = 'local';

  /** Umbral por debajo del cual no se corrige (la cabecera Date tiene resolución de 1 s). */
  public static readonly MIN_CORRECTION_MS = 1500;

  constructor(private readonly base: Clock) {}

  public now(): number {
    return this.base.now() + this.offsetMs;
  }

  public get offset(): number {
    return this.offsetMs;
  }

  public get origin(): string {
    return this.source;
  }

  /** Calibra con una observación (hora del servidor, hora local de recepción). */
  public calibrate(serverDateMs: number, localReceivedMs: number): number {
    const observed = serverDateMs - localReceivedMs;
    if (Math.abs(observed) >= TrustedClock.MIN_CORRECTION_MS) {
      this.offsetMs = observed;
    } else {
      this.offsetMs = 0;
    }
    this.source = 'http-date';
    return observed;
  }
}
