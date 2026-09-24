import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { HashChain, computeEventHash } from '../src/audit/hashChain';
import { BatchFile, computeBatchHash } from '../src/batching/batch';
import { BatchEngine } from '../src/batching/batchEngine';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { TimerApi } from '../src/session/timeGate';
import { WriteAheadLog } from '../src/storage/wal';
import { tmpDir } from './helpers';

class ManualTimers implements TimerApi {
  public pending = new Map<number, () => void>();
  private id = 0;
  setTimeout(fn: () => void) {
    this.pending.set(++this.id, fn);
    return this.id;
  }
  clearTimeout(h: unknown) {
    this.pending.delete(h as number);
  }
  setInterval() {
    return 0;
  }
  clearInterval() {}
  fireAll() {
    const fns = [...this.pending.values()];
    this.pending.clear();
    fns.forEach((f) => f());
  }
}

function setup(maxEvents = 3) {
  const dir = tmpDir();
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  const chain = new HashChain(kp.privateKeyDer, kp.publicKeyHex, { nextSequence: 0, lastHash: 'a'.repeat(64) });
  const wal = WriteAheadLog.open(dir);
  const timers = new ManualTimers();
  const produced: BatchFile[] = [];
  const engine = new BatchEngine({
    wal,
    sessionDir: dir,
    context: { sessionUuid: 'uuid-1', githubUser: 'octocat' },
    intervalMs: 30_000,
    maxEvents,
    signerDer: kp.privateKeyDer,
    clock: { now: () => Date.parse('2026-09-24T14:00:00Z') },
    headCommit: async () => 'b'.repeat(40),
    onBatch: (b) => produced.push(b),
    timers,
  });
  const record = (type: Parameters<HashChain['append']>[0] = 'heartbeat') => {
    const ev = chain.append(type, {}, Date.parse('2026-09-24T14:00:00Z'));
    wal.appendEvent(ev);
    engine.notify(ev);
    return ev;
  };
  return { dir, kp, wal, timers, engine, produced, record };
}

test('flush por tamaño genera un lote firmado y encadenado', async () => {
  const s = setup(3);
  const evs = [s.record(), s.record(), s.record()];
  await s.engine.flush('espera');
  assert.equal(s.produced.length, 1);
  const b = s.produced[0];
  assert.equal(b.batch_sequence_id, 0);
  assert.equal(b.events_count, 3);
  assert.equal(b.batch_start_hash, evs[0].prev_hash);
  assert.equal(b.batch_end_hash, computeEventHash(evs[2]));
  assert.equal(b.head_code_commit, 'b'.repeat(40));
  assert.ok(UatuCryptoEngine.verifyHash(computeBatchHash(b), b.batch_signature, s.kp.publicKeyHex));
  const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'batches', 'batch-000000.json'), 'utf-8'));
  assert.deepEqual(onDisk, b);
  assert.equal(s.wal.eventState(2), 'BATCHED');
});

test('flush por tiempo con el temporizador de ventana', async () => {
  const s = setup(20);
  s.record();
  s.record();
  assert.equal(s.timers.pending.size, 1);
  s.timers.fireAll();
  await s.engine.flush();
  assert.equal(s.produced.length, 1);
  assert.equal(s.produced[0].events_count, 2);
});

test('los eventos prioritarios fuerzan el volcado y los lotes se encadenan', async () => {
  const s = setup(20);
  s.record();
  s.record('disallowed_extension');
  await s.engine.flush();
  s.record();
  await s.engine.flush();
  assert.equal(s.produced.length, 2);
  assert.equal(s.produced[1].batch_start_hash, s.produced[0].batch_end_hash);
  assert.equal(s.produced[1].batch_sequence_id, 1);
  assert.equal(s.wal.pendingEvents().length, 0);
});

test('flush sin eventos pendientes no produce lotes', async () => {
  const s = setup();
  await s.engine.flush();
  assert.equal(s.produced.length, 0);
});
