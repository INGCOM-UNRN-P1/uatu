/**
 * Contabilidad de pérdida de foco de la ventana (RF-03).
 */

export interface FocusTransition {
  focused: boolean;
  /** Duración del último período fuera del editor (solo al recuperar el foco). */
  unfocused_ms?: number;
  unfocused_total_ms: number;
}

export class FocusTracker {
  private focused: boolean;
  private blurredAt: number | undefined;
  private totalUnfocusedMs = 0;

  constructor(initiallyFocused: boolean, nowMs: number) {
    this.focused = initiallyFocused;
    this.blurredAt = initiallyFocused ? undefined : nowMs;
  }

  public get isFocused(): boolean {
    return this.focused;
  }

  /** Tiempo acumulado fuera del editor, incluyendo el período en curso. */
  public totalUnfocused(nowMs: number): number {
    return this.totalUnfocusedMs + (this.blurredAt !== undefined ? Math.max(0, nowMs - this.blurredAt) : 0);
  }

  /** Aplica un cambio de estado; devuelve la transición o undefined si no cambió. */
  public update(focused: boolean, nowMs: number): FocusTransition | undefined {
    if (focused === this.focused) {
      return undefined;
    }
    this.focused = focused;
    if (!focused) {
      this.blurredAt = nowMs;
      return { focused: false, unfocused_total_ms: this.totalUnfocusedMs };
    }
    const period = this.blurredAt !== undefined ? Math.max(0, nowMs - this.blurredAt) : 0;
    this.blurredAt = undefined;
    this.totalUnfocusedMs += period;
    return { focused: true, unfocused_ms: period, unfocused_total_ms: this.totalUnfocusedMs };
  }
}
