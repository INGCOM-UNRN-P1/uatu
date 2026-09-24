import { AuditEvent, EventData, EventType } from '../audit/events';
import { HashChain } from '../audit/hashChain';
import { BatchEngine } from '../batching/batchEngine';
import { Clock } from '../core/time';
import { GitPlumbing } from '../git/gitPlumbing';
import { SyncDaemon, SyncStatus } from '../git/syncDaemon';
import { WriteAheadLog } from '../storage/wal';
import { SessionMetadata, SessionStore } from './sessionStore';
import { TimerApi } from './timeGate';

/**
 * Canal de auditoría de una sesión: une la cadena firmada, el WAL, el
 * motor de micro-lotes y el daemon de sincronización.
 */

export interface AuditStats {
  batches: number;
  events: number;
  pendingEvents: number;
  sync: SyncStatus;
}

export interface AuditSessionOptions {
  store: SessionStore;
  meta: SessionMetadata;
  privateKeyDer: Buffer | undefined;
  batchIntervalMs: number;
  batchMaxEvents: number;
  clock: Clock;
  timers?: TimerApi;
  random?: () => number;
  log?: (message: string) => void;
  onStats?: (stats: AuditStats) => void;
}

export class AuditSession {
  private readonly wal: WriteAheadLog;
  private readonly chain: HashChain | undefined;
  private readonly engine: BatchEngine;
  private readonly daemon: SyncDaemon;
  private readonly git: GitPlumbing;
  private disposed = false;

  constructor(private readonly opts: AuditSessionOptions) {
    const { meta, store } = opts;
    const dir = store.dir(meta.session_uuid);
    this.wal = WriteAheadLog.open(dir);
    this.git = new GitPlumbing(meta.repo_root);
    if (opts.privateKeyDer) {
      const state = this.wal.chainState() ?? { nextSequence: 0, lastHash: meta.genesis_hash };
      this.chain = new HashChain(opts.privateKeyDer, meta.student_public_key, state);
    }
    this.daemon = new SyncDaemon({
      wal: this.wal,
      sessionDir: dir,
      git: this.git,
      ref: meta.ref,
      remote: meta.remote_name,
      autoPush: meta.auto_push,
      maxBackoffMs: meta.max_backoff_ms,
      identity: { name: meta.github_user, email: `${meta.github_user}@users.noreply.github.com` },
      sessionUuid: meta.session_uuid,
      timers: opts.timers,
      random: opts.random,
      now: () => opts.clock.now(),
      log: opts.log,
      onStatus: () => this.emitStats(),
    });
    this.engine = new BatchEngine({
      wal: this.wal,
      sessionDir: dir,
      context: { sessionUuid: meta.session_uuid, githubUser: meta.github_user },
      intervalMs: opts.batchIntervalMs,
      maxEvents: opts.batchMaxEvents,
      signerDer: opts.privateKeyDer,
      clock: opts.clock,
      headCommit: () => this.git.headCommit(),
      timers: opts.timers,
      onError: (e) => opts.log?.(`[batch] error: ${(e as Error).message}`),
      onBatch: (batch, _file, reason) => {
        opts.log?.(`[batch] lote ${batch.batch_sequence_id} con ${batch.events_count} eventos (${reason})`);
        this.emitStats();
        void this.daemon.requestSync();
      },
    });
    // Eventos que quedaron RECORDED de una ejecución anterior.
    this.engine.arm();
  }

  public get metadata(): SessionMetadata {
    return this.opts.meta;
  }

  public get closedReason(): string | undefined {
    return this.wal.closed;
  }

  public get isFullySynced(): boolean {
    return this.wal.fullySynced;
  }

  public get stats(): AuditStats {
    return {
      batches: this.wal.nextBatchSequence,
      events: this.wal.totalEvents,
      pendingEvents: this.wal.pendingEvents().length,
      sync: this.daemon.currentStatus,
    };
  }

  private emitStats(): void {
    this.opts.onStats?.(this.stats);
  }

  public get canRecord(): boolean {
    return !this.disposed && this.chain !== undefined && this.wal.closed === undefined;
  }

  /** Registra un evento: se firma, se asienta en el WAL (fsync) y se agenda su lote. */
  public record(type: EventType, data: EventData): AuditEvent | undefined {
    if (!this.canRecord || !this.chain) {
      return undefined;
    }
    const event = this.chain.append(type, data, this.opts.clock.now());
    this.wal.appendEvent(event);
    this.engine.notify(event);
    this.emitStats();
    return event;
  }

  /** Empaqueta lo pendiente y solicita sincronización. */
  public async flush(reason = 'forzado'): Promise<void> {
    await this.engine.flush(reason);
    await this.daemon.requestSync();
  }

  /**
   * Cierra la sesión: registra session_end (si hay clave), vuelca el lote
   * final, marca el WAL como cerrado y espera la sincronización hasta
   * `waitMs`. Si el push no se completa, el daemon sigue reintentando
   * mientras la sesión no sea descartada, y el WAL garantiza la
   * recuperación en la próxima apertura.
   */
  public async close(reason: string, extra: EventData = {}, waitMs = 10_000): Promise<void> {
    if (this.wal.closed === undefined) {
      this.record('session_end', { reason, ...extra });
      await this.engine.flush('cierre');
      this.wal.markClosed(reason);
    }
    await this.syncWithin(waitMs);
  }

  /** Intenta sincronizar y espera como máximo `waitMs`. */
  public async syncWithin(waitMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs).unref();
    });
    await Promise.race([this.flush('sincronización'), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    return this.wal.fullySynced;
  }

  /** Libera temporizadores, el WAL y el lock de propiedad. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.engine.dispose();
    this.daemon.dispose();
    this.wal.close();
    this.opts.store.release(this.opts.meta.session_uuid);
  }
}
