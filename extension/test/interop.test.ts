import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { computeGenesisHash, EMPTY_COMMIT_SHA } from '../src/audit/hashChain';
import { parseManifest } from '../src/config/manifest';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { GitPlumbing } from '../src/git/gitPlumbing';
import { buildInsertionRecord } from '../src/monitors/insertionEvent';
import { AuditSession } from '../src/session/auditSession';
import { SessionStore } from '../src/session/sessionStore';
import { makeRepo, sh } from './gitHelpers';
import { baseManifest, makePki, signManifest, tmpDir } from './helpers';

/**
 * Interoperabilidad extensión -> validador: la telemetría producida por
 * los módulos reales de la extensión se empuja a un remoto, se clona como
 * lo haría el workflow de CI y se audita con scripts/uatu_audit.py.
 */

const AUDIT_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'uatu_audit.py');
const pythonReady =
  spawnSync('python3', ['-c', 'import cryptography'], { encoding: 'utf-8' }).status === 0 && fs.existsSync(AUDIT_SCRIPT);

test('la telemetría de la extensión es verificable y descifrable por uatu_audit.py', { skip: !pythonReady }, async () => {
  const pki = makePki();
  const { repo, remote } = makeRepo();

  const manifest = signManifest(
    baseManifest({
      session: {
        start_utc: '2026-01-10T13:00:00Z',
        deadline_utc: '2026-01-10T16:00:00Z',
        batch_interval_seconds: 30,
        batch_max_events: 3,
        sync_max_backoff_seconds: 60,
        heartbeat_interval_seconds: 120,
      },
    }),
    pki.teacherSign
  );
  fs.writeFileSync(path.join(repo, '.uatu.conf'), JSON.stringify(manifest, null, 2));
  sh(repo, 'add', '.uatu.conf');
  sh(repo, 'commit', '-q', '-m', 'enunciado');
  sh(repo, 'push', '-q', 'origin', 'main');
  const parsed = parseManifest(fs.readFileSync(path.join(repo, '.uatu.conf'), 'utf-8'));

  // Reloj simulado dentro de la ventana del examen.
  let now = Date.parse('2026-01-10T13:05:00Z');
  const clock = { now: () => now };

  const git = new GitPlumbing(repo);
  const keyPair = UatuCryptoEngine.generateStudentKeyPair();
  const sessionUuid = crypto.randomUUID();
  const user = 'octocat';
  const initialCommit = (await git.initialCommit()) ?? EMPTY_COMMIT_SHA;
  const store = new SessionStore(tmpDir());
  const meta = {
    format: 1 as const,
    session_uuid: sessionUuid,
    github_user: user,
    exam_id: parsed.manifest.exam_id,
    repo_root: repo,
    remote_name: 'origin',
    ref: `refs/heads/uatu-audit/${user}/${sessionUuid}`,
    auto_push: true,
    max_backoff_ms: 60_000,
    student_public_key: keyPair.publicKeyHex,
    genesis_hash: computeGenesisHash({
      initialCommitSha: initialCommit,
      configSha256: parsed.sha256,
      githubUser: user,
      studentPublicKeyHex: keyPair.publicKeyHex,
    }),
    created_at_utc: new Date(now).toISOString(),
  };
  store.create(meta);
  const session = new AuditSession({
    store, meta, privateKeyDer: keyPair.privateKeyDer, batchIntervalMs: 30_000, batchMaxEvents: 50, clock,
  });

  session.record('session_start', {
    exam_id: parsed.manifest.exam_id,
    session_uuid: sessionUuid,
    github_user: user,
    initial_commit_sha: initialCommit,
    config_sha256: parsed.sha256,
    teacher_key_id: 'prof-lead-2026',
    clock_offset_ms: 0,
    clock_source: 'http-date',
  });
  await session.flush('génesis');
  const pasted = 'int pick_next(struct rq *rq) {\n  return list_first(&rq->ready)->pid; // ñ\n}\n';
  for (const text of [pasted, 'short snippet of 20c']) {
    now += 60_000;
    const rec = buildInsertionRecord(
      {
        documentKey: 'file:///x', texts: [text], charCount: text.length,
        start: { line: 10, character: 0 }, end: { line: 13, character: 0 }, changeCount: 1, detectedAtMs: now,
      },
      { targetFile: 'src/scheduler.c', clipboardText: text, windowFocused: true, isActiveEditor: true },
      parsed.manifest.monitoring.clipboard,
      Buffer.from(pki.teacherEncryptHex, 'hex')
    );
    session.record(rec.type, rec.data);
  }
  await session.flush('pegados');
  now += 30_000;
  session.record('window_focus', { focused: false, unfocused_total_ms: 0 });
  now += 12_000;
  session.record('window_focus', { focused: true, unfocused_ms: 12_000, unfocused_total_ms: 12_000 });
  now += 60_000;
  session.record('heartbeat', { uptime_seconds: 252, window_focused: true, unfocused_total_ms: 12_000 });
  now += 60_000;
  await session.close('deadline');
  assert.ok(session.isFullySynced);
  session.dispose();

  // Clonado como en el workflow de CI.
  const ci = path.join(tmpDir('uatu-ci-'), 'clone');
  execFileSync('git', ['clone', '-q', remote, ci]);
  sh(ci, 'fetch', '-q', 'origin', '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*');

  const out = tmpDir('uatu-report-');
  const pem = path.join(out, 'teacher.pem');
  fs.writeFileSync(pem, pki.teacherDecrypt.export({ format: 'pem', type: 'pkcs8' }) as string);
  const md = path.join(out, 'report.md');
  const json = path.join(out, 'report.json');
  const run = spawnSync(
    'python3',
    [AUDIT_SCRIPT, '--repo', ci, '--teacher-key', pki.teacherVerifyHex, '--decrypt-key', pem, '--md-out', md, '--json-out', json],
    { encoding: 'utf-8' }
  );
  const report = JSON.parse(fs.readFileSync(json, 'utf-8'));
  assert.deepEqual(report.errors, [], run.stdout + run.stderr);
  assert.equal(run.status, 2, 'un pegado de más de 50 caracteres genera advertencia');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /Pegado masivo \(76 chars\)/);
  assert.match(report.warnings[0], /int pick_next\(struct rq \*rq\) \{ ⏎/);
  const [s] = report.sessions;
  assert.equal(s.github_user, user);
  assert.equal(s.session_uuid, sessionUuid);
  assert.equal(s.events, 7);
  assert.equal(s.batches, 3);
  assert.equal(s.clipboard_pastes, 2);
  assert.equal(s.unfocused_ms, 12_000);
  assert.equal(s.closed_reason, 'deadline');

  // Manipular un lote y reescribir la rama remota rompe la auditoría (exit 1).
  const ref = `refs/remotes/origin/uatu-audit/${user}/${sessionUuid}`;
  const file = sh(ci, 'ls-tree', '-r', '--name-only', ref).split('\n')[1];
  const batch = JSON.parse(sh(ci, 'show', `${ref}:${file}`));
  batch.events[0].data.char_count = 3;
  const tamperedGit = new GitPlumbing(ci);
  await tamperedGit.commitFile({
    ref, indexFile: path.join(out, 'idx'), pathInTree: file, content: JSON.stringify(batch),
    message: 'retoque', identity: { name: user, email: 'x@example.com' },
  });
  const rerun = spawnSync('python3', [AUDIT_SCRIPT, '--repo', ci, '--teacher-key', pki.teacherVerifyHex, '--md-out', md], {
    encoding: 'utf-8',
  });
  assert.equal(rerun.status, 1);
  assert.match(fs.readFileSync(md, 'utf-8'), /Firma digital del estudiante inválida/);
});
