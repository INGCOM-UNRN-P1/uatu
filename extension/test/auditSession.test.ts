import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { computeGenesisHash, verifyEventChain } from '../src/audit/hashChain';
import { BatchFile } from '../src/batching/batch';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { AuditSession } from '../src/session/auditSession';
import { SessionMetadata, SessionStore } from '../src/session/sessionStore';
import { makeRepo, sh } from './gitHelpers';
import { tmpDir } from './helpers';

function newSession(repo: string, store: SessionStore, uuid: string) {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  const genesis = computeGenesisHash({
    initialCommitSha: 'a'.repeat(40),
    configSha256: 'b'.repeat(64),
    githubUser: 'octocat',
    studentPublicKeyHex: kp.publicKeyHex,
  });
  const meta: SessionMetadata = {
    format: 1,
    session_uuid: uuid,
    github_user: 'octocat',
    exam_id: 'eval',
    repo_root: repo,
    remote_name: 'origin',
    ref: `refs/heads/uatu-audit/octocat/${uuid}`,
    auto_push: true,
    max_backoff_ms: 60_000,
    student_public_key: kp.publicKeyHex,
    genesis_hash: genesis,
    created_at_utc: new Date().toISOString(),
  };
  store.create(meta);
  return { kp, meta, genesis };
}

function readBranchEvents(remote: string, ref: string) {
  const files = sh(remote, 'ls-tree', '-r', '--name-only', ref).split('\n');
  const batches = files.map((f) => JSON.parse(sh(remote, 'show', `${ref}:${f}`)) as BatchFile);
  return batches.flatMap((b) => b.events);
}

test('sesión completa: registro, lotes, cierre y push al remoto', async () => {
  const { repo, remote } = makeRepo();
  const store = new SessionStore(tmpDir());
  const { kp, meta, genesis } = newSession(repo, store, 'aaaaaaaa-0000-4000-8000-000000000001');
  const session = new AuditSession({
    store, meta, privateKeyDer: kp.privateKeyDer, batchIntervalMs: 60_000, batchMaxEvents: 50, clock: { now: Date.now },
  });
  session.record('session_start', { exam_id: 'eval' });
  session.record('window_focus', { focused: false });
  session.record('window_focus', { focused: true });
  await session.close('deadline');
  assert.equal(session.closedReason, 'deadline');
  assert.ok(session.isFullySynced);
  assert.equal(session.record('heartbeat', {}), undefined, 'no se registra tras el cierre');
  session.dispose();

  const events = readBranchEvents(remote, meta.ref);
  assert.deepEqual(events.map((e) => e.event_type), ['session_start', 'window_focus', 'window_focus', 'session_end']);
  assert.deepEqual(verifyEventChain(events, genesis), []);
});

test('recupera una sesión huérfana tras un cierre abrupto y continúa la cadena', async () => {
  const { repo, remote } = makeRepo();
  const root = tmpDir();
  const deadPid = 999_999_999;
  const crashedStore = new SessionStore(root, deadPid, 'host', () => false);
  const { kp, meta, genesis } = newSession(repo, crashedStore, 'aaaaaaaa-0000-4000-8000-000000000002');
  const crashed = new AuditSession({
    store: crashedStore, meta, privateKeyDer: kp.privateKeyDer, batchIntervalMs: 60_000, batchMaxEvents: 50, clock: { now: Date.now },
  });
  crashed.record('heartbeat', { uptime_seconds: 1 });
  crashed.record('heartbeat', { uptime_seconds: 2 });
  // Simula el corte: no hay flush, close ni release.

  const store = new SessionStore(root, process.pid, 'host', () => false);
  const orphans = store.findOrphans(repo);
  assert.deepEqual(orphans.map((o) => o.session_uuid), [meta.session_uuid]);
  assert.ok(store.claim(meta.session_uuid));
  const recovered = new AuditSession({
    store, meta, privateKeyDer: kp.privateKeyDer, batchIntervalMs: 60_000, batchMaxEvents: 50, clock: { now: Date.now },
  });
  await recovered.close('recovered');
  recovered.dispose();

  const events = readBranchEvents(remote, meta.ref);
  assert.deepEqual(events.map((e) => e.event_type), ['heartbeat', 'heartbeat', 'session_end']);
  assert.deepEqual(verifyEventChain(events, genesis), []);
});

test('sin clave privada la recuperación empaqueta lo pendiente sin firma de lote', async () => {
  const { repo, remote } = makeRepo();
  const root = tmpDir();
  const s1 = new SessionStore(root, 1, 'host', () => false);
  const { kp, meta } = newSession(repo, s1, 'aaaaaaaa-0000-4000-8000-000000000003');
  const a = new AuditSession({ store: s1, meta, privateKeyDer: kp.privateKeyDer, batchIntervalMs: 60_000, batchMaxEvents: 50, clock: { now: Date.now } });
  a.record('heartbeat', {});

  const s2 = new SessionStore(root, 2, 'host', () => false);
  assert.ok(s2.claim(meta.session_uuid));
  const b = new AuditSession({ store: s2, meta, privateKeyDer: undefined, batchIntervalMs: 60_000, batchMaxEvents: 50, clock: { now: Date.now } });
  assert.equal(b.canRecord, false);
  await b.close('recovered_without_key');
  b.dispose();
  const [batchFile] = sh(remote, 'ls-tree', '-r', '--name-only', meta.ref).split('\n');
  const batch = JSON.parse(sh(remote, 'show', `${meta.ref}:${batchFile}`)) as BatchFile;
  assert.equal(batch.batch_signature, '');
  assert.equal(batch.events_count, 1);
});

test('el lock de propiedad impide que otra ventana viva recupere la sesión', () => {
  const root = tmpDir();
  const owner = new SessionStore(root, 10, 'host', (pid) => pid === 10 || pid === 20);
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  owner.create({
    format: 1, session_uuid: 'u1', github_user: 'x', exam_id: 'e', repo_root: '/repo', remote_name: 'origin',
    ref: 'refs/heads/uatu-audit/x/u1', auto_push: true, max_backoff_ms: 1000, student_public_key: '', genesis_hash: '',
    created_at_utc: '',
  });
  const other = new SessionStore(root, 20, 'host', (pid) => pid === 10 || pid === 20);
  assert.deepEqual(other.findOrphans('/repo'), []);
  assert.equal(other.claim('u1'), false);

  const later = new SessionStore(root, 20, 'host', (pid) => pid === 20);
  assert.equal(later.findOrphans('/repo').length, 1);
  assert.equal(later.claim('u1'), true);
  assert.equal(later.findOrphans('/other').length, 0);
});
