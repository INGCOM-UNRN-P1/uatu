import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent } from '../audit/events';
import { ChainState, computeEventHash } from '../audit/hashChain';

/**
 * Write-Ahead Log local en JSON Lines (Sección 6.1).
 *
 * Ubicación: ${globalStorageUri}/sessions/${sessionId}/events.wal
 *
 * Es un log de solo anexado: cada línea es un registro y los cambios de
 * estado se asientan como registros nuevos, nunca reescribiendo líneas.
 *
 *   {"type":"event","state":"RECORDED","event":{...}}
 *   {"type":"batch","state":"BATCHED","batch_sequence_id":4,"first_seq":18,"last_seq":20,"file":"batch-000004.json"}
 *   {"type":"sync","state":"SYNCED","batch_sequence_id":4,"commit":"<sha>"}
 *   {"type":"close","reason":"deadline"}
 *
 * Cada anexado es síncrono y se confirma con fsync antes de retornar, de
 * modo que un apagado abrupto no pierde eventos ya reportados como
 * registrados. Una línea final truncada (corte a mitad de escritura) se
 * descarta durante la recuperación.
 */

export const WAL_FILENAME = 'events.wal';

export type TransactionState = 'RECORDED' | 'BATCHED' | 'SYNCED';

export interface BatchRecord {
  batch_sequence_id: number;
  first_seq: number;
  last_seq: number;
  file: string;
  synced: boolean;
  commit?: string;
}

type WalRecord =
  | { type: 'event'; state: 'RECORDED'; event: AuditEvent }
  | { type: 'batch'; state: 'BATCHED'; batch_sequence_id: number; first_seq: number; last_seq: number; file: string }
  | { type: 'sync'; state: 'SYNCED'; batch_sequence_id: number; commit: string }
  | { type: 'close'; reason: string };

export class WalError extends Error {}

export class WriteAheadLog {
  private fd: number | undefined;
  private pending: AuditEvent[] = [];
  private lastEvent: AuditEvent | undefined;
  private eventCount = 0;
  private readonly batchList: BatchRecord[] = [];
  private closedReason: string | undefined;
  /** Longitud en bytes de la porción válida del archivo si hubo que descartar una cola truncada. */
  private validLength: number | undefined;

  private constructor(public readonly file: string) {}

  /** Abre (o crea) el WAL y reconstruye su estado a partir del disco. */
  public static open(dir: string): WriteAheadLog {
    fs.mkdirSync(dir, { recursive: true });
    const wal = new WriteAheadLog(path.join(dir, WAL_FILENAME));
    wal.recover();
    if (wal.validLength !== undefined) {
      // Elimina la cola truncada para que el próximo registro empiece limpio.
      fs.truncateSync(wal.file, wal.validLength);
    }
    wal.fd = fs.openSync(wal.file, 'a');
    return wal;
  }

  private recover(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.file, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw e;
    }
    const lines = content.split('\n');
    const lastIndex = lines.length - 1;
    let offset = 0;
    lines.forEach((line, idx) => {
      const lineStart = offset;
      offset += Buffer.byteLength(line, 'utf-8') + 1;
      if (line.trim() === '') {
        return;
      }
      let record: WalRecord;
      try {
        record = JSON.parse(line) as WalRecord;
      } catch {
        if (idx === lastIndex) {
          this.validLength = lineStart;
          return;
        }
        throw new WalError(`WAL corrupto en la línea ${idx + 1} de ${this.file}.`);
      }
      if (idx === lastIndex) {
        // Registro completo pero sin salto de línea final: se conserva y se completa.
        this.apply(record);
        fs.appendFileSync(this.file, '\n');
        return;
      }
      this.apply(record);
    });
  }

  private apply(record: WalRecord): void {
    switch (record.type) {
      case 'event':
        this.pending.push(record.event);
        this.lastEvent = record.event;
        this.eventCount++;
        break;
      case 'batch': {
        this.batchList.push({
          batch_sequence_id: record.batch_sequence_id,
          first_seq: record.first_seq,
          last_seq: record.last_seq,
          file: record.file,
          synced: false,
        });
        this.pending = this.pending.filter((e) => e.sequence_id > record.last_seq);
        break;
      }
      case 'sync': {
        for (const b of this.batchList) {
          if (b.batch_sequence_id <= record.batch_sequence_id && !b.synced) {
            b.synced = true;
            b.commit = record.commit;
          }
        }
        break;
      }
      case 'close':
        this.closedReason = record.reason;
        break;
    }
  }

  private write(record: WalRecord): void {
    if (this.fd === undefined) {
      throw new WalError('El WAL está cerrado.');
    }
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(this.fd);
    this.apply(record);
  }

  /** Asienta un evento firmado (estado RECORDED). */
  public appendEvent(event: AuditEvent): void {
    if (this.closedReason !== undefined) {
      throw new WalError('No se pueden registrar eventos en una sesión cerrada.');
    }
    const expected = this.lastEvent ? this.lastEvent.sequence_id + 1 : 0;
    if (event.sequence_id !== expected) {
      throw new WalError(`Secuencia inesperada: ${event.sequence_id} (se esperaba ${expected}).`);
    }
    this.write({ type: 'event', state: 'RECORDED', event });
  }

  /** Marca como BATCHED los eventos [firstSeq, lastSeq] incluidos en un lote. */
  public markBatched(batchSequenceId: number, firstSeq: number, lastSeq: number, file: string): void {
    if (batchSequenceId !== this.nextBatchSequence) {
      throw new WalError(`Lote fuera de orden: ${batchSequenceId}.`);
    }
    this.write({ type: 'batch', state: 'BATCHED', batch_sequence_id: batchSequenceId, first_seq: firstSeq, last_seq: lastSeq, file });
  }

  /** Marca como SYNCED todos los lotes hasta `batchSequenceId` inclusive. */
  public markSynced(batchSequenceId: number, commit: string): void {
    this.write({ type: 'sync', state: 'SYNCED', batch_sequence_id: batchSequenceId, commit });
  }

  public markClosed(reason: string): void {
    if (this.closedReason === undefined) {
      this.write({ type: 'close', reason });
    }
  }

  /** Eventos en estado RECORDED (aún no incluidos en un lote). */
  public pendingEvents(): AuditEvent[] {
    return [...this.pending];
  }

  public get batches(): BatchRecord[] {
    return this.batchList.map((b) => ({ ...b }));
  }

  public unsyncedBatches(): BatchRecord[] {
    return this.batches.filter((b) => !b.synced);
  }

  public get nextBatchSequence(): number {
    return this.batchList.length;
  }

  public get totalEvents(): number {
    return this.eventCount;
  }

  public get closed(): string | undefined {
    return this.closedReason;
  }

  /** Estado transaccional de un evento concreto. */
  public eventState(sequenceId: number): TransactionState | undefined {
    if (!this.lastEvent || sequenceId > this.lastEvent.sequence_id || sequenceId < 0) {
      return undefined;
    }
    const batch = this.batchList.find((b) => sequenceId >= b.first_seq && sequenceId <= b.last_seq);
    if (!batch) {
      return 'RECORDED';
    }
    return batch.synced ? 'SYNCED' : 'BATCHED';
  }

  /** Estado de la cadena para reanudarla, o undefined si no hay eventos. */
  public chainState(): ChainState | undefined {
    if (!this.lastEvent) {
      return undefined;
    }
    return { nextSequence: this.lastEvent.sequence_id + 1, lastHash: computeEventHash(this.lastEvent) };
  }

  /** Verdadero si no queda nada por empaquetar ni sincronizar. */
  public get fullySynced(): boolean {
    return this.pending.length === 0 && this.batchList.every((b) => b.synced);
  }

  public close(): void {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
