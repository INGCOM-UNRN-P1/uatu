import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RegistryError, RegistryResolver, resolveTeacher, verifyRegistry } from '../src/config/registry';
import { makePki, tmpDir } from './helpers';

test('verifica la firma raíz y resuelve el certificado docente', () => {
  const pki = makePki();
  const reg = verifyRegistry(pki.registry, pki.anchors);
  const cert = resolveTeacher(reg, 'prof-lead-2026', Date.now());
  assert.equal(cert.verifyKeyHex, pki.teacherVerifyHex);
  assert.equal(cert.encryptionKey.toString('hex'), pki.teacherEncryptHex);
  assert.throws(() => resolveTeacher(reg, 'otro', Date.now()), RegistryError);
});

test('rechaza registros manipulados o de raíces desconocidas', () => {
  const pki = makePki();
  const tampered = structuredClone(pki.registry);
  tampered.teachers['prof-lead-2026'].x25519_encryption_key = '00'.repeat(32);
  assert.throws(() => verifyRegistry(tampered, pki.anchors), /firma raíz/);
  assert.throws(() => verifyRegistry(pki.registry, makePki().anchors.map((a) => ({ ...a, key_id: 'x' }))), /raíz desconocida/);
});

test('valida la vigencia de la clave docente', () => {
  const pki = makePki();
  const reg = structuredClone(pki.registry);
  reg.teachers['prof-lead-2026'].not_after_utc = '2020-01-01T00:00:00Z';
  assert.throws(() => resolveTeacher(reg, 'prof-lead-2026', Date.now()), /vencida/);
});

test('usa la caché firmada cuando la red falla, pero nunca ante firma inválida', async () => {
  const pki = makePki();
  const dir = tmpDir();
  const url = 'https://example.invalid/keys.json';
  let mode: 'ok' | 'down' | 'forged' = 'ok';
  const resolver = new RegistryResolver(pki.anchors, dir, async () => {
    if (mode === 'down') {
      throw new Error('ENOTFOUND');
    }
    const body = mode === 'ok' ? pki.registry : { ...pki.registry, signature: '00'.repeat(64) };
    return { body: JSON.stringify(body), receivedAtMs: 1000, serverDateMs: 5000 };
  });

  const first = await resolver.resolve(url);
  assert.equal(first.fromCache, false);
  assert.equal(first.serverDateMs, 5000);

  mode = 'down';
  const second = await resolver.resolve(url);
  assert.equal(second.fromCache, true);

  mode = 'forged';
  await assert.rejects(resolver.resolve(url), /firma raíz/);

  const empty = new RegistryResolver(pki.anchors, tmpDir(), async () => {
    throw new Error('offline');
  });
  await assert.rejects(empty.resolve(url), /no hay copia local/);
});
