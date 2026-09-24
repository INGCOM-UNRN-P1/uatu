import { AuditEvent } from '../audit/events';
import { computeEventHash } from '../audit/hashChain';
import { canonicalBytes, omitKey } from '../core/canonicalJson';
import { isoUtc } from '../core/time';
import { sha256Hex, UatuCryptoEngine } from '../crypto/cryptoEngine';

/**
 * Archivo de micro-lote `batch-<seq>.json` (Sección 6.2).
 *
 *   batch_start_hash = prev_hash del primer evento (= batch_end_hash del lote anterior)
 *   batch_end_hash   = H del último evento
 *   batch_signature  = Ed25519(StudentPrivKey, SHA-256(Serialize(lote sin batch_signature)))
 */

export const BATCH_FORMAT_VERSION = '2.1';
export const BATCHES_DIR = 'batches';

export interface BatchFile {
  version: string;
  batch_sequence_id: number;
  session_uuid: string;
  github_user: string;
  created_at_utc: string;
  head_code_commit: string | null;
  batch_start_hash: string;
  batch_end_hash: string;
  events_count: number;
  events: AuditEvent[];
  batch_signature: string;
}

export interface BatchContext {
  sessionUuid: string;
  githubUser: string;
}

export function batchFileName(sequenceId: number): string {
  return `batch-${String(sequenceId).padStart(6, '0')}.json`;
}

export function computeBatchHash(batch: BatchFile | Omit<BatchFile, 'batch_signature'>): string {
  const unsigned = 'batch_signature' in batch ? omitKey(batch, 'batch_signature') : batch;
  return sha256Hex(canonicalBytes(unsigned));
}

/**
 * Construye y firma un lote. Si no se dispone de la clave privada (por
 * ejemplo, al recuperar una sesión cuyo secreto fue eliminado) el lote se
 * emite con `batch_signature` vacía: cada evento sigue firmado de forma
 * individual y el validador lo reporta como advertencia.
 */
export function buildBatch(
  ctx: BatchContext,
  sequenceId: number,
  events: AuditEvent[],
  headCodeCommit: string | null,
  nowMs: number,
  signerDer: Buffer | undefined
): BatchFile {
  if (events.length === 0) {
    throw new Error('No se puede construir un lote vacío.');
  }
  const unsigned: Omit<BatchFile, 'batch_signature'> = {
    version: BATCH_FORMAT_VERSION,
    batch_sequence_id: sequenceId,
    session_uuid: ctx.sessionUuid,
    github_user: ctx.githubUser,
    created_at_utc: isoUtc(nowMs),
    head_code_commit: headCodeCommit,
    batch_start_hash: events[0].prev_hash,
    batch_end_hash: computeEventHash(events[events.length - 1]),
    events_count: events.length,
    events,
  };
  const signature = signerDer ? UatuCryptoEngine.signHash(computeBatchHash(unsigned), signerDer) : '';
  return { ...unsigned, batch_signature: signature };
}

export function serializeBatch(batch: BatchFile): string {
  return JSON.stringify(batch, null, 2) + '\n';
}
