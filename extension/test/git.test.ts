import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { HashChain } from '../src/audit/hashChain';
import { BatchEngine } from '../src/batching/batchEngine';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { computeBackoffMs } from '../src/git/backoff';
import { GitPlumbing } from '../src/git/gitPlumbing';
import { SyncDaemon, SyncStatus } from '../src/git/syncDaemon';
import { TimerApi } from '../src/session/timeGate';
import { WriteAheadLog } from '../src/storage/wal';
import { makeRepo, sh } from './gitHelpers';
import { tmpDir } from './helpers';

const REF = 'refs/heads/uatu-audit/octocat/11111111-1111-4111-8111-111111111111';
const identity = { name: 'octocat', email: 'octocat@users.noreply.github.com' };

test('backoff exponencial acotado con jitter uniforme en [0.8, 1.2]', () => {
  assert.equal(computeBackoffMs(0, 60_000, () => 0.5), 2_000);
  assert.equal(computeBackoffMs(3, 60_000, () => 0.5), 16_000);
  assert.equal(computeBackoffMs(10, 60_000, () => 0.5), 60_000);
  assert.equal(computeBackoffMs(10, 60_000, () => 0), 48_000);
  assert.equal(computeBackoffMs(10, 60_000, () => 1), 72_000);
  for (let i = 0; i < 200; i++) {
    const v = computeBackoffMs(2, 60_000);
    assert.ok(v >= 6_400 && v <= 9_600);
  }
});

test('commitFile crea una rama huérfana sin tocar index, working tree ni HEAD', async () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'main.c'), 'int main(void) { return 1; }\n');
  fs.writeFileSync(path.join(repo, 'nuevo.c'), '// staged\n');
  sh(repo, 'add', 'nuevo.c');
  const statusBefore = sh(repo, 'status', '--porcelain');
  const headBefore = sh(repo, 'rev-parse', 'HEAD');

  const git = new GitPlumbing(repo);
  const index = path.join(tmpDir(), 'idx');
  const c1 = await git.commitFile({ ref: REF, indexFile: index, pathInTree: 'batches/batch-000000.json', content: '{"a":1}\n', message: 'lote 0', identity });
  const c2 = await git.commitFile({ ref: REF, indexFile: index, pathInTree: 'batches/batch-000001.json', content: '{"a":2}\n', message: 'lote 1', identity });

  assert.equal(sh(repo, 'status', '--porcelain'), statusBefore);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(sh(repo, 'rev-parse', 'refs/heads/main'), headBefore);
  assert.equal(sh(repo, 'rev-list', '--max-parents=0', c1), c1, 'el primer commit es huérfano');
  assert.equal(sh(repo, 'rev-parse', `${c2}^`), c1);
  assert.throws(() => sh(repo, 'merge-base', c2, 'main'));
  assert.equal(sh(repo, 'ls-tree', '-r', '--name-only', c2), 'batches/batch-000000.json\nbatches/batch-000001.json');
  assert.ok(await git.pathExists(REF, 'batches/batch-000001.json'));
  assert.equal(await git.initialCommit(), headBefore);
  assert.equal(sh(repo, 'log', '-1', '--format=%an', c2), 'octocat');
});

class ManualTimers implements TimerApi {
  public pending = new Map<number, () => void>();
  public delays: number[] = [];
  private id = 0;
  setTimeout(fn: () => void, ms: number) {
    this.delays.push(ms);
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

async function pipeline(repo: string, autoPush = true) {
  const sessionDir = tmpDir();
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  const chain = new HashChain(kp.privateKeyDer, kp.publicKeyHex, { nextSequence: 0, lastHash: 'a'.repeat(64) });
  const wal = WriteAheadLog.open(sessionDir);
  const git = new GitPlumbing(repo);
  const timers = new ManualTimers();
  const statuses: SyncStatus[] = [];
  const daemon = new SyncDaemon({
    wal, sessionDir, git, ref: REF, remote: 'origin', autoPush, maxBackoffMs: 60_000, identity,
    sessionUuid: 'uuid', timers, random: () => 0.5, onStatus: (s) => statuses.push(s),
  });
  const engine = new BatchEngine({
    wal, sessionDir, context: { sessionUuid: 'uuid', githubUser: 'octocat' }, intervalMs: 1000, maxEvents: 100,
    signerDer: kp.privateKeyDer, clock: { now: Date.now }, headCommit: () => git.headCommit(),
    onBatch: () => void daemon.requestSync(), timers,
  });
  const record = async (n: number) => {
    for (let i = 0; i < n; i++) {
      wal.appendEvent(chain.append('heartbeat', { i }, Date.now()));
    }
    await engine.flush();
    await daemon.idle();
  };
  return { wal, daemon, timers, statuses, record };
}

test('sincroniza lotes al remoto y los marca SYNCED', async () => {
  const { repo, remote } = makeRepo();
  const p = await pipeline(repo);
  await p.record(3);
  await p.record(2);
  await p.daemon.idle();
  assert.equal(p.wal.unsyncedBatches().length, 0);
  assert.equal(p.wal.eventState(4), 'SYNCED');
  assert.equal(sh(remote, 'rev-parse', REF), sh(repo, 'rev-parse', REF));
  assert.equal(sh(remote, 'ls-tree', '-r', '--name-only', REF).split('\n').length, 2);
});

test('reintenta con backoff cuando el remoto no está disponible', async () => {
  const { repo, remote } = makeRepo();
  sh(repo, 'remote', 'set-url', 'origin', remote + '-inexistente');
  const p = await pipeline(repo);
  await p.record(1);
  assert.equal(p.wal.unsyncedBatches().length, 1);
  assert.equal(p.timers.delays.at(-1), 2_000);
  const last = p.statuses.at(-1)!;
  assert.ok(last.lastError);
  assert.equal(last.pendingBatches, 1);

  // Segundo intento falla: el retardo se duplica.
  p.timers.fireAll();
  await p.daemon.idle();
  assert.equal(p.timers.delays.at(-1), 4_000);

  // Se recupera la red: el reintento sincroniza todo lo pendiente.
  sh(repo, 'remote', 'set-url', 'origin', remote);
  p.timers.fireAll();
  await p.daemon.idle();
  await p.daemon.idle();
  assert.equal(p.wal.unsyncedBatches().length, 0);
  assert.equal(p.statuses.at(-1)!.lastError, undefined);
  p.daemon.dispose();
});

test('con auto_push=false solo confirma localmente', async () => {
  const { repo, remote } = makeRepo();
  const p = await pipeline(repo, false);
  await p.record(2);
  assert.ok(sh(repo, 'rev-parse', REF));
  assert.throws(() => sh(remote, 'rev-parse', '--verify', REF));
  assert.equal(p.wal.eventState(0), 'BATCHED');
});
