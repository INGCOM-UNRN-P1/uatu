import * as path from 'path';
import { AuditEvent, PRIORITY_EVENTS } from '../audit/events';
import { Clock } from '../core/time';
import { TimerApi, nodeTimers } from '../session/timeGate';
import { writeFileAtomicSync } from '../storage/fsUtil';
import { WriteAheadLog } from '../storage/wal';
import { BATCHES_DIR, BatchContext, BatchFile, batchFileName, buildBatch, serializeBatch } from './batch';

/**
 * Procesador de micro-lotes (Sección 6).
 *
 * Criterios de flush:
 *  - Tiempo: el evento pendiente más antiguo alcanza batch_interval_seconds.
 *  - Tamaño: hay batch_max_events eventos pendientes.
 *  - Forzado: eventos prioritarios, guardado del estudiante, cierre del IDE
 *    o fin del examen (flush explícito).
 */

export interface BatchEngineOptions {
  wal: WriteAheadLog;
  sessionDir: string;
  context: BatchContext;
  intervalMs: number;
  maxEvents: number;
  signerDer?: Buffer;
  clock: Clock;
  headCommit: () => Promise<string | null>;
  /** Se invoca con cada lote persistido y el criterio que disparó el flush. */
  onBatch: (batch: BatchFile, file: string, reason: string) => void;
  timers?: TimerApi;
  onError?: (error: unknown) => void;
}

export class BatchEngine {
  private timer: unknown;
  private queue: Promise<void> = Promise.resolve();
  private readonly timers: TimerApi;
  private disposed = false;

  constructor(private readonly opts: BatchEngineOptions) {
    this.timers = opts.timers ?? nodeTimers;
  }

  public get batchesDir(): string {
    return path.join(this.opts.sessionDir, BATCHES_DIR);
  }

  /** Debe invocarse después de asentar un evento en el WAL. */
  public notify(event: AuditEvent): void {
    if (this.disposed) {
      return;
    }
    if (PRIORITY_EVENTS.has(event.event_type)) {
      void this.flush(`prioridad:${event.event_type}`);
      return;
    }
    if (this.opts.wal.pendingEvents().length >= this.opts.maxEvents) {
      void this.flush('tamaño');
      return;
    }
    this.arm();
  }

  /** Arma el temporizador de ventana si hay eventos pendientes y no está armado. */
  public arm(): void {
    if (this.timer !== undefined || this.disposed || this.opts.wal.pendingEvents().length === 0) {
      return;
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.flush('tiempo');
    }, this.opts.intervalMs);
  }

  /**
   * Empaqueta todos los eventos pendientes en un lote. Las invocaciones se
   * serializan para que los lotes se numeren y encadenen sin carreras.
   */
  public flush(reason = 'forzado'): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.timer !== undefined) {
        this.timers.clearTimeout(this.timer);
        this.timer = undefined;
      }
      const events = this.opts.wal.pendingEvents();
      if (events.length === 0) {
        return;
      }
      let head: string | null = null;
      try {
        head = await this.opts.headCommit();
      } catch {
        head = null;
      }
      const sequenceId = this.opts.wal.nextBatchSequence;
      const batch = buildBatch(this.opts.context, sequenceId, events, head, this.opts.clock.now(), this.opts.signerDer);
      const file = batchFileName(sequenceId);
      writeFileAtomicSync(path.join(this.batchesDir, file), serializeBatch(batch));
      this.opts.wal.markBatched(sequenceId, events[0].sequence_id, events[events.length - 1].sequence_id, file);
      this.opts.onBatch(batch, file, reason);
      // Eventos registrados mientras se construía el lote quedan para el próximo.
      this.arm();
    };
    this.queue = this.queue.then(run).catch((e) => this.opts.onError?.(e));
    return this.queue;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
