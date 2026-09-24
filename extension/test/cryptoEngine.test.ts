import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import {
  exportRawPublicKey,
  importPublicKey,
  rawPublicKeyToDer,
  sha256Hex,
  UatuCryptoEngine,
} from '../src/crypto/cryptoEngine';

function teacherX25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return {
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
    pubRaw: exportRawPublicKey(publicKey),
  };
}

test('cifrado híbrido: ida y vuelta con clave cruda y con SPKI DER', () => {
  const teacher = teacherX25519();
  const message = 'int main(void) { return 0; } // ñ ✓';
  for (const pub of [teacher.pubRaw, rawPublicKeyToDer(teacher.pubRaw, 'x25519')]) {
    const env = UatuCryptoEngine.encryptClipboard(message, pub);
    assert.equal(env.algorithm, 'X25519-AES-256-GCM');
    assert.equal(Buffer.from(env.ephemeral_public_key, 'base64').length, 32);
    assert.equal(Buffer.from(env.iv, 'base64').length, 12);
    assert.equal(Buffer.from(env.auth_tag, 'base64').length, 16);
    assert.equal(UatuCryptoEngine.decryptClipboard(env, teacher.priv), message);
  }
});

test('cada sobre usa clave efímera e IV distintos', () => {
  const teacher = teacherX25519();
  const a = UatuCryptoEngine.encryptClipboard('x', teacher.pubRaw);
  const b = UatuCryptoEngine.encryptClipboard('x', teacher.pubRaw);
  assert.notEqual(a.ephemeral_public_key, b.ephemeral_public_key);
  assert.notEqual(a.iv, b.iv);
});

test('la manipulación del ciphertext se detecta por el tag GCM', () => {
  const teacher = teacherX25519();
  const env = UatuCryptoEngine.encryptClipboard('contenido secreto', teacher.pubRaw);
  const ct = Buffer.from(env.ciphertext_base64, 'base64');
  ct[0] ^= 0xff;
  assert.throws(() =>
    UatuCryptoEngine.decryptClipboard({ ...env, ciphertext_base64: ct.toString('base64') }, teacher.priv)
  );
});

test('una clave de otro docente no descifra', () => {
  const a = teacherX25519();
  const b = teacherX25519();
  const env = UatuCryptoEngine.encryptClipboard('hola', a.pubRaw);
  assert.throws(() => UatuCryptoEngine.decryptClipboard(env, b.priv));
});

test('firma y verificación Ed25519 de hashes', () => {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  assert.match(kp.publicKeyHex, /^[0-9a-f]{64}$/);
  assert.equal(UatuCryptoEngine.studentPublicKeyHex(kp.privateKeyDer), kp.publicKeyHex);
  const h = sha256Hex('evento');
  const sig = UatuCryptoEngine.signHash(h, kp.privateKeyDer);
  assert.equal(sig.length, 128);
  assert.ok(UatuCryptoEngine.verifyHash(h, sig, kp.publicKeyHex));
  assert.ok(!UatuCryptoEngine.verifyHash(sha256Hex('otro'), sig, kp.publicKeyHex));
  assert.ok(!UatuCryptoEngine.verifyHash(h, 'zz', kp.publicKeyHex));
  assert.throws(() => UatuCryptoEngine.signHash('no-hex', kp.privateKeyDer));
});

test('importPublicKey valida el tipo de clave', () => {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  assert.throws(() => importPublicKey(rawPublicKeyToDer(Buffer.from(kp.publicKeyHex, 'hex'), 'ed25519'), 'x25519'));
  assert.throws(() => rawPublicKeyToDer(Buffer.alloc(31), 'x25519'));
});
