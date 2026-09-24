import * as fs from 'fs';
import * as path from 'path';
import { BATCHES_DIR } from '../batching/batch';
import { TimerApi, nodeTimers } from '../session/timeGate';
import { WriteAheadLog } from '../storage/wal';
import { computeBackoffMs } from './backoff';
import { CommitIdentity, GitPlumbing } from './gitPlumbing';

/**
 * Daemon de sincronización Git (Sección 6).
 *
 *  1. Commit atómico de cada lote BATCHED en la rama huérfana local.
 *  2. Push diferido de la rama; ante fallas reintenta con backoff
 *     exponencial y jitter para evitar tormentas de pushes.
 *  3. Tras un push exitoso marca los lotes como SYNCED en el WAL.
 */

export interface SyncStatus {
  pendingBatches: number;
  attempt: number;
  lastError?: string;
  nextRetryAtMs?: number;
  lastSyncAtMs?: number;
  lastCommit?: string;
}

export interface SyncDaemonOptions {
  wal: WriteAheadLog;
  sessionDir: string;
  git: GitPlumbing;
  ref: string;
  remote: string;
  autoPush: boolean;
  maxBackoffMs: number;
  identity: CommitIdentity;
  sessionUuid: string;
  timers?: TimerApi;
  random?: () => number;
  now?: () => number;
  onStatus?: (status: SyncStatus) => void;
  log?: (message: string) => void;
}

export class SyncDaemon {
  private queue: Promise<void> = Promise.resolve();
  private retryTimer: unknown;
  private attempt = 0;
  private status: SyncStatus = { pendingBatches: 0, attempt: 0 };
  private disposed = false;
  private readonly timers: TimerApi;
  private readonly indexFile: string;

  constructor(private readonly opts: SyncDaemonOptions) {
    this.timers = opts.timers ?? nodeTimers;
    this.indexFile = path.join(opts.sessionDir, 'git-index');
  }

  public get currentStatus(): SyncStatus {
    return { ...this.status, pendingBatches: this.opts.wal.unsyncedBatches().length };
  }

  private emit(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch, pendingBatches: this.opts.wal.unsyncedBatches().length, attempt: this.attempt };
    this.opts.onStatus?.(this.currentStatus);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((e) => {
      this.opts.log?.(`[sync] error inesperado: ${(e as Error).message}`);
    });
    return this.queue;
  }

  /** Crea los commits faltantes para los lotes no sincronizados. */
  private async commitPending(): Promise<string | undefined> {
    let last: string | undefined;
    for (const batch of this.opts.wal.unsyncedBatches()) {
      const pathInTree = `${BATCHES_DIR}/${batch.file}`;
      if (await this.opts.git.pathExists(this.opts.ref, pathInTree)) {
        continue;
      }
      const content = fs.readFileSync(path.join(this.opts.sessionDir, BATCHES_DIR, batch.file));
      last = await this.opts.git.commitFile({
        ref: this.opts.ref,
        indexFile: this.indexFile,
        pathInTree,
        content,
        identity: this.opts.identity,
        message:
          `uatu: lote ${batch.batch_sequence_id} (eventos ${batch.first_seq}-${batch.last_seq})\n\n` +
          `Uatu-Session: ${this.opts.sessionUuid}\nUatu-Batch: ${batch.batch_sequence_id}\n`,
      });
      this.opts.log?.(`[sync] lote ${batch.batch_sequence_id} confirmado en ${this.opts.ref} (${last.slice(0, 10)})`);
    }
    return last ?? (await this.opts.git.resolveRef(this.opts.ref)) ?? undefined;
  }

  /** Solicita commit + push. Las solicitudes se serializan. */
  public requestSync(): Promise<void> {
    return this.enqueue(() => this.syncOnce());
  }

  private async syncOnce(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const unsynced = this.opts.wal.unsyncedBatches();
    if (unsynced.length === 0) {
      this.emit({ lastError: undefined, nextRetryAtMs: undefined });
      return;
    }
    let tip: string | undefined;
    try {
      tip = await this.commitPending();
    } catch (e) {
      this.scheduleRetry(`commit local: ${(e as Error).message}`);
      return;
    }
    this.emit({ lastCommit: tip });
    if (!this.opts.autoPush || !tip) {
      return;
    }
    try {
      if (!(await this.opts.git.remoteExists(this.opts.remote))) {
        throw new Error(`el remoto "${this.opts.remote}" no está configurado`);
      }
      await this.opts.git.push(this.opts.remote, this.opts.ref);
    } catch (e) {
      const reason = GitPlumbing.isNonFastForward(e)
        ? 'el remoto rechazó el push (non-fast-forward): la rama remota fue alterada'
        : (e as Error).message;
      this.scheduleRetry(reason);
      return;
    }
    const lastSeq = unsynced[unsynced.length - 1].batch_sequence_id;
    this.opts.wal.markSynced(lastSeq, tip);
    this.attempt = 0;
    this.emit({ lastError: undefined, nextRetryAtMs: undefined, lastSyncAtMs: (this.opts.now ?? Date.now)() });
    this.opts.log?.(`[sync] push exitoso de ${this.opts.ref} hasta el lote ${lastSeq}`);
    if (this.opts.wal.unsyncedBatches().length > 0) {
      void this.requestSync();
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.disposed) {
      return;
    }
    const delay = computeBackoffMs(this.attempt, this.opts.maxBackoffMs, this.opts.random);
    this.attempt++;
    const now = (this.opts.now ?? Date.now)();
    this.emit({ lastError: reason, nextRetryAtMs: now + delay });
    this.opts.log?.(`[sync] falla (${reason}); reintento #${this.attempt} en ${delay} ms`);
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
    }
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      void this.requestSync();
    }, delay);
  }

  /** Espera a que termine la cola actual (útil en pruebas y en el cierre). */
  public idle(): Promise<void> {
    return this.queue;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
