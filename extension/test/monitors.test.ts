import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { EncryptedPayload, exportRawPublicKey, sha256Hex, UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import { buildInsertionRecord } from '../src/monitors/insertionEvent';
import { DetectedInsertion, endPosition, InsertionDetector, matchesClipboard } from '../src/monitors/insertionDetector';
import { FocusTracker } from '../src/monitors/focusTracker';
import { auditExtensions, ExtensionState } from '../src/monitors/extensionAudit';
import { TimerApi } from '../src/session/timeGate';

class ClockTimers implements TimerApi {
  now = 0;
  private id = 0;
  timeouts = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number) {
    this.timeouts.set(++this.id, { at: this.now + ms, fn });
    return this.id;
  }
  clearTimeout(h: unknown) {
    this.timeouts.delete(h as number);
  }
  setInterval() {
    return 0;
  }
  clearInterval() {}
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.timeouts]) {
      if (t.at <= this.now) {
        this.timeouts.delete(id);
        t.fn();
      }
    }
  }
}

function detector(threshold = 15) {
  const timers = new ClockTimers();
  const found: DetectedInsertion[] = [];
  const d = new InsertionDetector(threshold, (i) => found.push(i), { now: () => timers.now }, timers);
  return { timers, found, d };
}

test('un cambio grande se clasifica como inserción al cerrar la ventana de 50 ms', () => {
  const { timers, found, d } = detector();
  d.feed('a.c', [{ text: 'for (int i = 0; i < n; i++) {\n  x++;\n}', start: { line: 4, character: 2 } }]);
  assert.equal(found.length, 0);
  timers.advance(50);
  assert.equal(found.length, 1);
  assert.equal(found[0].charCount, 38);
  assert.deepEqual(found[0].start, { line: 4, character: 2 });
  assert.deepEqual(found[0].end, { line: 6, character: 1 });
});

test('el tipeo humano no supera el umbral', () => {
  const { timers, found, d } = detector();
  for (const ch of 'int main(void) { return 0; }') {
    d.feed('a.c', [{ text: ch, start: { line: 0, character: 0 } }]);
    timers.advance(80);
  }
  assert.equal(found.length, 0);
});

test('cambios en ráfaga (< 50 ms) se agregan, p. ej. pegado multicursor', () => {
  const { timers, found, d } = detector();
  d.feed('a.c', [
    { text: 'printf("a");', start: { line: 1, character: 0 } },
    { text: 'printf("b");', start: { line: 2, character: 0 } },
  ]);
  timers.advance(10);
  d.feed('a.c', [{ text: 'x', start: { line: 3, character: 0 } }]);
  timers.advance(50);
  assert.equal(found.length, 1);
  assert.equal(found[0].charCount, 25);
  assert.equal(found[0].changeCount, 3);
});

test('umbral estricto: exactamente character_threshold no dispara', () => {
  const { timers, found, d } = detector(5);
  d.feed('a.c', [{ text: '12345', start: { line: 0, character: 0 } }]);
  timers.advance(50);
  d.feed('a.c', [{ text: '123456', start: { line: 0, character: 0 } }]);
  timers.advance(50);
  assert.equal(found.length, 1);
});

test('las eliminaciones puras se ignoran y flushAll cierra ráfagas abiertas', () => {
  const { found, d } = detector(3);
  d.feed('a.c', [{ text: '', start: { line: 0, character: 0 } }]);
  d.feed('b.c', [{ text: 'abcdef', start: { line: 0, character: 0 } }]);
  d.flushAll();
  assert.deepEqual(found.map((f) => f.documentKey), ['b.c']);
});

test('endPosition y matchesClipboard', () => {
  assert.deepEqual(endPosition({ line: 2, character: 3 }, 'abc'), { line: 2, character: 6 });
  assert.deepEqual(endPosition({ line: 2, character: 3 }, 'a\r\nbc'), { line: 3, character: 2 });
  assert.ok(matchesClipboard(['  if (x) {\n    y();\n  }'], 'if (x) {\r\n  y();\r\n}'));
  assert.ok(matchesClipboard(['uno', 'dos'], 'uno\ndos'));
  assert.ok(!matchesClipboard(['uno'], ''));
  assert.ok(!matchesClipboard(['codigo generado'], 'otra cosa'));
});

test('FocusTracker acumula el tiempo fuera del editor', () => {
  const t = new FocusTracker(true, 0);
  assert.equal(t.update(true, 10), undefined);
  assert.deepEqual(t.update(false, 1_000), { focused: false, unfocused_total_ms: 0 });
  assert.equal(t.totalUnfocused(1_500), 500);
  assert.deepEqual(t.update(true, 4_000), { focused: true, unfocused_ms: 3_000, unfocused_total_ms: 3_000 });
  t.update(false, 5_000);
  assert.deepEqual(t.update(true, 6_000), { focused: true, unfocused_ms: 1_000, unfocused_total_ms: 4_000 });
});

test('auditExtensions reporta solo transiciones de extensiones bloqueadas', () => {
  const prev = new Map<string, ExtensionState>();
  const blocked = ['GitHub.Copilot', 'continue.continue'];
  let f = auditExtensions(
    [
      { id: 'github.copilot', version: '1.0', isActive: false },
      { id: 'ms-vscode.cpptools', version: '2', isActive: true },
    ],
    blocked,
    prev
  );
  assert.deepEqual(f, [{ extension_id: 'github.copilot', version: '1.0', state: 'installed' }]);
  f = auditExtensions([{ id: 'github.copilot', version: '1.0', isActive: false }], blocked, prev);
  assert.deepEqual(f, []);
  f = auditExtensions([{ id: 'GitHub.copilot', version: '1.0', isActive: true }], blocked, prev);
  assert.deepEqual(f, [{ extension_id: 'github.copilot', version: '1.0', state: 'active' }]);
  f = auditExtensions([], blocked, prev);
  assert.deepEqual(f, [{ extension_id: 'github.copilot', version: '', state: 'removed' }]);
});


test('buildInsertionRecord cifra el texto insertado y clasifica el origen', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const teacherPub = exportRawPublicKey(publicKey);
  const insertion = {
    documentKey: 'k', texts: ['void f(void) { g(); }'], charCount: 21,
    start: { line: 1, character: 0 }, end: { line: 1, character: 21 }, changeCount: 1, detectedAtMs: 0,
  };
  const settings = { enabled: true, character_threshold: 15, encrypt_content: true, hash_algorithm: 'sha256' as const };
  const paste = buildInsertionRecord(
    insertion,
    { targetFile: 'src/f.c', clipboardText: 'void f(void) { g(); }', windowFocused: true, isActiveEditor: true },
    settings,
    teacherPub
  );
  assert.equal(paste.type, 'clipboard_paste');
  assert.equal(paste.data.sha256_plaintext, sha256Hex('void f(void) { g(); }'));
  assert.deepEqual(paste.data.range, { start: [1, 0], end: [1, 21] });
  const env = paste.data.encrypted_payload as unknown as EncryptedPayload;
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  assert.equal(UatuCryptoEngine.decryptClipboard(env, der), 'void f(void) { g(); }');
  assert.equal(paste.data.clipboard_sha256, undefined);

  const external = buildInsertionRecord(
    insertion,
    { targetFile: 'src/f.c', clipboardText: 'otra cosa', windowFocused: false, isActiveEditor: false },
    { ...settings, encrypt_content: false },
    teacherPub
  );
  assert.equal(external.type, 'external_insertion');
  assert.equal(external.data.encrypted_payload, undefined);
  assert.equal(external.data.clipboard_sha256, sha256Hex('otra cosa'));
  assert.equal(external.data.window_focused, false);
});
