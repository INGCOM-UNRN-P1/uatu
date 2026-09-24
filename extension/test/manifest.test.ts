import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ManifestError, parseManifest, verifyManifestSignature } from '../src/config/manifest';
import { baseManifest, makePki, signManifest } from './helpers';

test('parsea el manifiesto de ejemplo y aplica valores por omisión', () => {
  const m = baseManifest();
  delete (m.git as Record<string, unknown>).remote_name;
  const parsed = parseManifest(JSON.stringify(m));
  assert.equal(parsed.manifest.git.remote_name, 'origin');
  assert.equal(parsed.startMs, Date.parse('2026-09-24T13:00:00Z'));
  assert.equal(parsed.deadlineMs, Date.parse('2026-09-24T16:00:00Z'));
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
});

test('el hash del manifiesto es independiente del formato del archivo', () => {
  const m = baseManifest();
  const a = parseManifest(JSON.stringify(m));
  const b = parseManifest(JSON.stringify(m, null, 4).replace(/\n/g, '\r\n'));
  assert.equal(a.sha256, b.sha256);
});

test('rechaza ventanas temporales invertidas y campos inválidos', () => {
  const bad = baseManifest({
    session: { start_utc: '2026-09-24T16:00:00Z', deadline_utc: '2026-09-24T13:00:00Z' },
  });
  assert.throws(() => parseManifest(JSON.stringify(bad)), ManifestError);
  assert.throws(() => parseManifest(JSON.stringify(baseManifest({ exam_id: '../x' }))), ManifestError);
  assert.throws(() => parseManifest(JSON.stringify(baseManifest({ version: '1.0' }))), ManifestError);
  assert.throws(
    () => parseManifest(JSON.stringify(baseManifest({ git: { telemetry_branch_prefix: 'a/../b' } }))),
    ManifestError
  );
  assert.throws(() => parseManifest('{no json'), ManifestError);
});

test('verifica la firma docente y detecta alteraciones', () => {
  const pki = makePki();
  const signed = signManifest(baseManifest(), pki.teacherSign);
  const parsed = parseManifest(JSON.stringify(signed));
  assert.ok(verifyManifestSignature(parsed, pki.teacherVerifyHex));

  const tampered = structuredClone(signed) as Record<string, any>;
  tampered.session.deadline_utc = '2026-09-24T20:00:00Z';
  assert.ok(!verifyManifestSignature(parseManifest(JSON.stringify(tampered)), pki.teacherVerifyHex));

  const other = makePki();
  assert.ok(!verifyManifestSignature(parsed, other.teacherVerifyHex));
});
