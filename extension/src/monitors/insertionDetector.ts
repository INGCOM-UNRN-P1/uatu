import { Clock } from '../core/time';
import { TimerApi, nodeTimers } from '../session/timeGate';

/**
 * Detector de inserciones masivas (RF-01).
 *
 * Un cambio (o una ráfaga de cambios sobre el mismo documento dentro de
 * una ventana de 50 ms, p. ej. un pegado multicursor) que introduce más
 * caracteres que `character_threshold` se clasifica como inserción
 * externa o pegado. El tipeo humano produce ráfagas de 1 carácter.
 */

export const INSERTION_WINDOW_MS = 50;

export interface Position {
  line: number;
  character: number;
}

export interface ChangeInput {
  text: string;
  start: Position;
}

export interface DetectedInsertion {
  documentKey: string;
  /** Textos insertados en orden de llegada. */
  texts: string[];
  charCount: number;
  start: Position;
  end: Position;
  changeCount: number;
  detectedAtMs: number;
}

interface Burst {
  documentKey: string;
  startedAt: number;
  changes: ChangeInput[];
  timer: unknown;
}

/** Posición final tras insertar `text` a partir de `start`. */
export function endPosition(start: Position, text: string): Position {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length === 1) {
    return { line: start.line, character: start.character + text.length };
  }
  return { line: start.line + lines.length - 1, character: lines[lines.length - 1].length };
}

export class InsertionDetector {
  private readonly bursts = new Map<string, Burst>();

  constructor(
    private readonly threshold: number,
    private readonly onInsertion: (insertion: DetectedInsertion) => void,
    private readonly clock: Clock,
    private readonly timers: TimerApi = nodeTimers,
    private readonly windowMs: number = INSERTION_WINDOW_MS
  ) {}

  public feed(documentKey: string, changes: ChangeInput[]): void {
    const inserted = changes.filter((c) => c.text.length > 0);
    if (inserted.length === 0) {
      return;
    }
    const now = this.clock.now();
    let burst = this.bursts.get(documentKey);
    if (burst && now - burst.startedAt >= this.windowMs) {
      this.finalize(documentKey);
      burst = undefined;
    }
    if (!burst) {
      burst = { documentKey, startedAt: now, changes: [], timer: undefined };
      burst.timer = this.timers.setTimeout(() => this.finalize(documentKey), this.windowMs);
      this.bursts.set(documentKey, burst);
    }
    burst.changes.push(...inserted);
  }

  private finalize(documentKey: string): void {
    const burst = this.bursts.get(documentKey);
    if (!burst) {
      return;
    }
    this.bursts.delete(documentKey);
    this.timers.clearTimeout(burst.timer);
    const texts = burst.changes.map((c) => c.text);
    const charCount = texts.reduce((acc, t) => acc + t.length, 0);
    if (charCount <= this.threshold) {
      return;
    }
    const first = burst.changes[0];
    const last = burst.changes[burst.changes.length - 1];
    this.onInsertion({
      documentKey,
      texts,
      charCount,
      start: first.start,
      end: endPosition(last.start, last.text),
      changeCount: burst.changes.length,
      detectedAtMs: this.clock.now(),
    });
  }

  /** Finaliza todas las ráfagas abiertas (al desmontar los observadores). */
  public flushAll(): void {
    for (const key of [...this.bursts.keys()]) {
      this.finalize(key);
    }
  }
}

/** Normaliza para comparar ignorando espacios (auto-indentación al pegar, CRLF). */
function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * Determina si lo insertado proviene del portapapeles. La comparación
 * ignora espacios en blanco porque VS Code puede reindentar al pegar y
 * distribuye las líneas entre cursores en pegados multicursor.
 */
export function matchesClipboard(inserted: string[], clipboard: string): boolean {
  const clip = stripWhitespace(clipboard);
  if (clip.length === 0) {
    return false;
  }
  return stripWhitespace(inserted.join('')) === clip;
}
