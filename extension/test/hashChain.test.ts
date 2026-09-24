import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { UatuCryptoEngine, sha256Hex } from '../src/crypto/cryptoEngine';
import { computeEventHash, computeGenesisHash, HashChain, verifyEventChain } from '../src/audit/hashChain';

function makeChain() {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  const genesis = computeGenesisHash({
    initialCommitSha: 'a'.repeat(40),
    configSha256: sha256Hex('conf'),
    githubUser: 'octocat',
    studentPublicKeyHex: kp.publicKeyHex,
  });
  return { kp, genesis, chain: new HashChain(kp.privateKeyDer, kp.publicKeyHex, { nextSequence: 0, lastHash: genesis }) };
}

test('el génesis concatena los componentes en el orden especificado', () => {
  const g = computeGenesisHash({
    initialCommitSha: '1'.repeat(40),
    configSha256: '2'.repeat(64),
    githubUser: 'octocat',
    studentPublicKeyHex: '3'.repeat(64),
  });
  assert.equal(g, sha256Hex('1'.repeat(40) + '2'.repeat(64) + 'octocat' + '3'.repeat(64)));
});

test('encadena eventos y los firma sobre H_i', () => {
  const { kp, genesis, chain } = makeChain();
  const e0 = chain.append('session_start', { exam_id: 'x' }, Date.parse('2026-09-24T13:00:00Z'));
  const e1 = chain.append('heartbeat', { uptime_seconds: 120 }, Date.parse('2026-09-24T13:02:00Z'));
  assert.equal(e0.prev_hash, genesis);
  assert.equal(e1.prev_hash, computeEventHash(e0));
  assert.equal(e1.sequence_id, 1);
  assert.equal(e0.timestamp_utc, '2026-09-24T13:00:00.000Z');
  assert.equal(e0.student_public_key, `ed25519:${kp.publicKeyHex}`);
  assert.ok(UatuCryptoEngine.verifyHash(computeEventHash(e1), e1.signature, kp.publicKeyHex));
  assert.deepEqual(verifyEventChain([e0, e1], genesis), []);
  assert.deepEqual(chain.snapshot, { nextSequence: 2, lastHash: computeEventHash(e1) });
});

test('detecta manipulación de datos, reordenamiento y eliminación', () => {
  const { genesis, chain } = makeChain();
  const events = [0, 1, 2].map((i) => chain.append('heartbeat', { uptime_seconds: i }, 1_000 * i));

  const tampered = structuredClone(events);
  tampered[1].data.uptime_seconds = 999;
  assert.ok(verifyEventChain(tampered, genesis).some((e) => e.includes('Firma inválida en seq 1')));
  assert.ok(verifyEventChain(tampered, genesis).some((e) => e.includes('Ruptura de cadena en seq 2')));

  assert.ok(verifyEventChain([events[0], events[2]], genesis).length > 0);
  assert.ok(verifyEventChain(events, 'f'.repeat(64)).some((e) => e.includes('seq 0')));
});

test('una cadena puede reanudarse desde su estado persistido', () => {
  const { kp, genesis, chain } = makeChain();
  const e0 = chain.append('session_start', {}, 0);
  const resumed = new HashChain(kp.privateKeyDer, kp.publicKeyHex, chain.snapshot);
  const e1 = resumed.append('session_end', { reason: 'shutdown' }, 1);
  assert.deepEqual(verifyEventChain([e0, e1], genesis), []);
});
