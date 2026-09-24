import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { makeRepo, sh } from './gitHelpers';
import { auditCommand, baseManifest, makePki, signManifest, tmpDir } from './helpers';
import { events, fileUri, installVscodeMock, makeFolder, makeSecrets, state } from './vscodeMock';

installVscodeMock();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UatuController } = require('../src/vscode/controller') as typeof import('../src/vscode/controller');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { UatuStatusBar } = require('../src/vscode/statusBar') as typeof import('../src/vscode/statusBar');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SecretKeyVault } = require('../src/vscode/secretVault') as typeof import('../src/vscode/secretVault');

const audit = auditCommand();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Tiempo de espera agotado');
    }
    await sleep(20);
  }
}

function setupExam(startOffsetMs: number, durationMs: number) {
  const pki = makePki();
  const { repo, remote } = makeRepo();
  const regFile = path.join(tmpDir(), 'keys.json');
  fs.writeFileSync(regFile, JSON.stringify(pki.registry));
  const now = Date.now();
  const manifest = signManifest(
    baseManifest({
      session: {
        start_utc: new Date(now + startOffsetMs).toISOString(),
        deadline_utc: new Date(now + startOffsetMs + durationMs).toISOString(),
        batch_interval_seconds: 1,
        batch_max_events: 20,
        sync_max_backoff_seconds: 5,
        heartbeat_interval_seconds: 60,
      },
      auth: { public_key_registry_url: pathToFileURL(regFile).toString(), require_github_auth: true },
    }),
    pki.teacherSign
  );
  fs.writeFileSync(path.join(repo, '.uatu.conf'), JSON.stringify(manifest, null, 2));
  sh(repo, 'add', '.uatu.conf');
  sh(repo, 'commit', '-q', '-m', 'enunciado');
  sh(repo, 'push', '-q', 'origin', 'main');
  return { pki, repo, remote, manifest };
}

function makeController(anchors: ReturnType<typeof makePki>['anchors']) {
  const secrets = makeSecrets();
  const context = {
    globalStorageUri: fileUri(tmpDir('uatu-storage-')),
    extension: { packageJSON: { version: '2.1.0-test' } },
    secrets,
  };
  const statusBar = new UatuStatusBar();
  const controller = new UatuController({
    context: context as never,
    anchors,
    vault: new SecretKeyVault(secrets as never),
    statusBar,
    output: { appendLine() {}, show() {}, dispose() {} } as never,
  });
  return { controller, statusBar, secrets };
}

function resetState(repo: string) {
  state.folders = [makeFolder(repo)];
  state.messages = [];
  state.statusTexts = [];
  state.statusMessages = [];
  state.focused = true;
  state.acceptDisclaimer = true;
  state.extensions = [];
}

test('flujo ACTIVO completo: consentimiento, pegado, foco, extensión prohibida y cierre verificable', async () => {
  const exam = setupExam(-60_000, 3_600_000);
  resetState(exam.repo);
  state.extensions = [{ id: 'GitHub.copilot', isActive: true, packageJSON: { version: '1.2.3' } }];
  const { controller, statusBar, secrets } = makeController(exam.pki.anchors);
  await controller.initialize();
  await waitFor(() => statusBar.current.kind === 'active');
  assert.match(state.statusTexts.at(-1)!, /^\$\(shield\) Uatu: @octocat \(Lote: \d+, Eventos: \d+\)$/);
  assert.equal(secrets.raw.size, 1, 'la clave de sesión se guarda en SecretStorage');
  assert.ok(state.messages.some((m) => m.text.includes('github.copilot')), 'se avisa de la extensión prohibida');

  const pasted = 'static int fib(int n) {\n  return n < 2 ? n : fib(n - 1) + fib(n - 2);\n}\n';
  state.clipboard = pasted;
  events.changeText.fire({
    document: { uri: fileUri(path.join(exam.repo, 'src', 'fib.c')) },
    reason: undefined,
    contentChanges: [{ text: pasted, range: { start: { line: 3, character: 0 } } }],
  });
  await waitFor(() => state.statusMessages.length > 0);
  assert.match(state.statusMessages[0], /^\[Uatu\] Portapapeles registrado y cifrado \(Hash: [0-9a-f]{4}\.\.\.\)$/);

  // Undo no se registra; archivos de .git tampoco.
  events.changeText.fire({
    document: { uri: fileUri(path.join(exam.repo, 'src', 'fib.c')) },
    reason: 1,
    contentChanges: [{ text: pasted, range: { start: { line: 3, character: 0 } } }],
  });
  state.focused = false;
  events.windowState.fire({ focused: false });
  await sleep(30);
  state.focused = true;
  events.windowState.fire({ focused: true });

  await controller.shutdown();
  controller.dispose();
  assert.equal(secrets.raw.size, 0, 'la clave se elimina al cerrar la sesión');

  const ci = path.join(tmpDir('uatu-ci-'), 'clone');
  execFileSync('git', ['clone', '-q', exam.remote, ci]);
  sh(ci, 'fetch', '-q', 'origin', '+refs/heads/uatu-audit/*:refs/remotes/origin/uatu-audit/*');
  const refs = sh(ci, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/uatu-audit/').split('\n');
  assert.equal(refs.length, 1);
  assert.match(refs[0], /^refs\/remotes\/origin\/uatu-audit\/octocat\/[0-9a-f-]{36}$/);
  const files = sh(ci, 'ls-tree', '-r', '--name-only', refs[0]).split('\n');
  const evs = files.flatMap((f) => JSON.parse(sh(ci, 'show', `${refs[0]}:${f}`)).events);
  assert.deepEqual(
    evs.map((e: { event_type: string }) => e.event_type),
    ['session_start', 'disallowed_extension', 'clipboard_paste', 'window_focus', 'window_focus', 'session_end']
  );
  assert.equal(evs.at(-1).data.reason, 'shutdown');
  assert.equal(evs[2].data.target_file, 'src/fib.c');
  assert.equal(sh(exam.repo, 'status', '--porcelain'), '', 'el working tree del estudiante queda intacto');

  if (audit) {
    const pem = path.join(tmpDir(), 't.pem');
    fs.writeFileSync(pem, exam.pki.teacherDecrypt.export({ format: 'pem', type: 'pkcs8' }) as string);
    const json = path.join(tmpDir(), 'r.json');
    const run = spawnSync(
      audit.cmd,
      [...audit.args, '--repo', ci, '--teacher-key', exam.pki.teacherVerifyHex, '--decrypt-key', pem, '--md-out', path.join(tmpDir(), 'r.md'), '--json-out', json],
      { encoding: 'utf-8' }
    );
    const report = JSON.parse(fs.readFileSync(json, 'utf-8'));
    assert.deepEqual(report.errors, []);
    assert.equal(run.status, 2);
    assert.ok(report.warnings.some((w: string) => w.includes('github.copilot')));
    assert.ok(report.warnings.some((w: string) => w.includes('static int fib(int n) {')));
  }
});

test('STANDBY hasta start_utc, activación automática y CONCLUIDO al deadline', async () => {
  const exam = setupExam(1_500, 2_000);
  resetState(exam.repo);
  const { controller, statusBar } = makeController(exam.pki.anchors);
  await controller.initialize();
  assert.equal(statusBar.current.kind, 'standby');
  assert.match(state.statusTexts.at(-1)!, /^\$\(clock\) Uatu: Esperando inicio \(\d{2}:\d{2} UTC\)$/);
  await waitFor(() => statusBar.current.kind === 'active', 4_000);
  await waitFor(() => statusBar.current.kind === 'concluded', 6_000);
  assert.equal(state.statusTexts.at(-1), '$(check) Uatu: Examen Concluido');
  await waitFor(() => /concluyó/.test(state.messages.map((m) => m.text).join('\n')), 2_000);
  const ref = sh(exam.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/uatu-audit/');
  const files = sh(exam.remote, 'ls-tree', '-r', '--name-only', ref).split('\n');
  const last = JSON.parse(sh(exam.remote, 'show', `${ref}:${files.at(-1)}`));
  assert.equal(last.events.at(-1).event_type, 'session_end');
  assert.equal(last.events.at(-1).data.reason, 'deadline');
  await controller.shutdown();
  controller.dispose();
});

test('ERROR DE INTEGRIDAD ante un manifiesto alterado y consentimiento rechazado', async () => {
  const exam = setupExam(-60_000, 3_600_000);
  resetState(exam.repo);
  const tampered = structuredClone(exam.manifest) as Record<string, any>;
  tampered.session.deadline_utc = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(path.join(exam.repo, '.uatu.conf'), JSON.stringify(tampered));
  const a = makeController(exam.pki.anchors);
  await a.controller.initialize();
  assert.equal(a.statusBar.current.kind, 'error');
  assert.ok(state.messages.some((m) => m.level === 'error' && /INVÁLIDA/.test(m.text)));
  a.controller.dispose();

  // Anclas raíz ajenas: el registro no es confiable.
  fs.writeFileSync(path.join(exam.repo, '.uatu.conf'), JSON.stringify(exam.manifest));
  const b = makeController(makePki().anchors.map((x) => ({ ...x, ed25519_public_key: crypto.randomBytes(32).toString('hex') })));
  await b.controller.initialize();
  assert.equal(b.statusBar.current.kind, 'error');
  b.controller.dispose();

  state.acceptDisclaimer = false;
  const c = makeController(exam.pki.anchors);
  await c.controller.initialize();
  await waitFor(() => c.statusBar.current.kind === 'declined');
  assert.equal(sh(exam.repo, 'for-each-ref', 'refs/heads/uatu-audit/'), '', 'sin consentimiento no hay telemetría');
  await c.controller.shutdown();
  c.controller.dispose();
});

test('sin .uatu.conf la extensión permanece inactiva', async () => {
  const { repo } = makeRepo();
  resetState(repo);
  const { controller, statusBar } = makeController(makePki().anchors);
  await controller.initialize();
  assert.equal(statusBar.current.kind, 'idle');
  assert.equal(state.statusTexts.at(-1), '$(shield) Uatu: Inactivo');
  controller.dispose();
});
