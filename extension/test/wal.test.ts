import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { HashChain, computeEventHash } from '../src/audit/hashChain';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { WAL_FILENAME, WalError, WriteAheadLog } from '../src/storage/wal';
import { tmpDir } from './helpers';

function chain() {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  return new HashChain(kp.privateKeyDer, kp.publicKeyHex, { nextSequence: 0, lastHash: 'g'.repeat(64) });
}

test('recorre los estados RECORDED -> BATCHED -> SYNCED', () => {
  const dir = tmpDir();
  const wal = WriteAheadLog.open(dir);
  const c = chain();
  for (let i = 0; i < 3; i++) {
    wal.appendEvent(c.append('heartbeat', { n: i }, i));
  }
  assert.equal(wal.pendingEvents().length, 3);
  assert.equal(wal.eventState(1), 'RECORDED');

  wal.markBatched(0, 0, 1, 'batch-000000.json');
  assert.equal(wal.eventState(1), 'BATCHED');
  assert.equal(wal.eventState(2), 'RECORDED');
  assert.deepEqual(wal.pendingEvents().map((e) => e.sequence_id), [2]);

  wal.markSynced(0, 'c'.repeat(40));
  assert.equal(wal.eventState(0), 'SYNCED');
  assert.equal(wal.fullySynced, false);
  wal.markBatched(1, 2, 2, 'batch-000001.json');
  wal.markSynced(1, 'd'.repeat(40));
  assert.equal(wal.fullySynced, true);
  wal.close();
});

test('recupera el estado completo tras reabrir', () => {
  const dir = tmpDir();
  const c = chain();
  const wal = WriteAheadLog.open(dir);
  const events = [0, 1, 2, 3].map((i) => c.append('heartbeat', { n: i }, i));
  events.forEach((e) => wal.appendEvent(e));
  wal.markBatched(0, 0, 2, 'batch-000000.json');
  wal.close();

  const again = WriteAheadLog.open(dir);
  assert.equal(again.totalEvents, 4);
  assert.equal(again.nextBatchSequence, 1);
  assert.deepEqual(again.unsyncedBatches().map((b) => b.batch_sequence_id), [0]);
  assert.deepEqual(again.pendingEvents().map((e) => e.sequence_id), [3]);
  assert.deepEqual(again.chainState(), { nextSequence: 4, lastHash: computeEventHash(events[3]) });
  again.close();
});

test('descarta una línea final truncada por un corte abrupto y sigue operando', () => {
  const dir = tmpDir();
  const c = chain();
  const wal = WriteAheadLog.open(dir);
  wal.appendEvent(c.append('heartbeat', {}, 0));
  wal.close();
  fs.appendFileSync(path.join(dir, WAL_FILENAME), '{"type":"event","state":"REC');

  const again = WriteAheadLog.open(dir);
  assert.equal(again.totalEvents, 1);
  again.appendEvent(c.append('heartbeat', {}, 1));
  again.close();

  const third = WriteAheadLog.open(dir);
  assert.equal(third.totalEvents, 2);
  third.close();
});

test('rechaza corrupción intermedia, secuencias inválidas y eventos tras el cierre', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, WAL_FILENAME), 'basura\n{"type":"close","reason":"x"}\n');
  assert.throws(() => WriteAheadLog.open(dir), WalError);

  const wal = WriteAheadLog.open(tmpDir());
  const c = chain();
  const e0 = c.append('heartbeat', {}, 0);
  const e1 = c.append('heartbeat', {}, 1);
  assert.throws(() => wal.appendEvent(e1), /Secuencia inesperada/);
  wal.appendEvent(e0);
  wal.markClosed('deadline');
  assert.equal(wal.closed, 'deadline');
  assert.throws(() => wal.appendEvent(e1), /sesión cerrada/);
  wal.close();
});
