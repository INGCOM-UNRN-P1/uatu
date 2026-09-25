import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeEventHash, HashChain } from '../src/audit/hashChain';
import { EventType } from '../src/audit/events';
import { UatuCryptoEngine } from '../src/crypto/cryptoEngine';
import {
  buildLogTree,
  buildStatusTree,
  formatDuration,
  renderEventDetail,
  summarizeEvent,
  UatuSnapshot,
  ViewNode,
} from '../src/views/model';

const T0 = Date.parse('2026-09-25T13:00:00Z');

function snapshot(overrides: Partial<UatuSnapshot> = {}): UatuSnapshot {
  const kp = UatuCryptoEngine.generateStudentKeyPair();
  const chain = new HashChain(kp.privateKeyDer, kp.publicKeyHex, { nextSequence: 0, lastHash: 'a'.repeat(64) });
  const specs: Array<[EventType, Record<string, unknown>]> = [
    ['session_start', { exam_id: 'demo', github_user: 'octocat' }],
    ['clipboard_paste', { target_file: 'src/a.c', char_count: 85, window_focused: true, range: { start: [2, 0], end: [5, 1] },
      sha256_plaintext: 'b'.repeat(64), encrypted_payload: { algorithm: 'X25519-AES-256-GCM', ciphertext_base64: 'AAAA' } }],
    ['window_focus', { focused: false, unfocused_total_ms: 0 }],
    ['window_focus', { focused: true, unfocused_ms: 90_000, unfocused_total_ms: 90_000 }],
    ['disallowed_extension', { extension_id: 'github.copilot', version: '1', state: 'active' }],
    ['heartbeat', { uptime_seconds: 240 }],
  ];
  const events = specs.map(([t, d], i) => chain.append(t, d as never, T0 + i * 60_000));
  return {
    nowMs: T0 + 10 * 60_000,
    phase: 'active',
    clock: { source: 'http-date', offsetMs: -80 },
    exam: {
      examId: 'demo-p1-2026', startMs: T0 - 3_600_000, deadlineMs: T0 + 2 * 3_600_000, teacherKeyId: 'demo',
      registryUrl: 'https://raw.githubusercontent.com/o/r/main/keys.json', manifestPath: '/r/.uatu.conf',
      clipboard: { enabled: true, threshold: 15, encrypt: true }, windowFocus: true,
      disallowedExtensions: ['github.copilot', 'continue.continue'], heartbeatSeconds: 120, batchIntervalSeconds: 30,
      batchMaxEvents: 20, autoPush: true, remote: 'origin', branchPrefix: 'uatu-audit',
    },
    session: {
      uuid: 'u-1', user: 'octocat', ref: 'refs/heads/uatu-audit/octocat/u-1', studentPublicKey: kp.publicKeyHex,
      genesisHash: 'a'.repeat(64), createdMs: T0, directory: '/tmp/s',
      stats: { batches: 2, events: 6, pendingEvents: 1, sync: { pendingBatches: 1, attempt: 2, lastError: 'sin red', nextRetryAtMs: T0 + 11 * 60_000 } },
    },
    monitors: { focused: true, unfocusedTotalMs: 90_000, lastHeartbeatMs: T0 + 5 * 60_000,
      extensions: [{ id: 'github.copilot', state: 'active' }], insertions: 1 },
    events: events.map((event, i) => ({ event, state: i < 3 ? 'SYNCED' : i < 5 ? 'BATCHED' : 'RECORDED', batch: i < 3 ? 0 : i < 5 ? 1 : undefined })),
    batches: [
      { batch_sequence_id: 0, first_seq: 0, last_seq: 2, file: 'batch-000000.json', synced: true, commit: 'c'.repeat(40) },
      { batch_sequence_id: 1, first_seq: 3, last_seq: 4, file: 'batch-000001.json', synced: false },
    ],
    ...overrides,
  };
}

function find(nodes: ViewNode[], id: string): ViewNode | undefined {
  for (const n of nodes) {
    if (n.id === id) {
      return n;
    }
    const inner = find(n.children ?? [], id);
    if (inner) {
      return inner;
    }
  }
  return undefined;
}

test('formatDuration', () => {
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(125_000), '2 min 5 s');
  assert.equal(formatDuration(2 * 3_600_000 + 13 * 60_000), '2 h 13 min');
  assert.equal(formatDuration(3 * 86_400_000 + 3_600_000), '3 d 1 h');
  assert.equal(formatDuration(-5), '0 s');
});

test('estado: fase activa con cuenta regresiva, sesión, monitores y sincronización', () => {
  const nodes = buildStatusTree(snapshot());
  assert.equal(nodes[0].label, 'Sesión activa');
  assert.equal(nodes[0].description, 'cierra en 1 h 50 min');
  assert.equal(find(nodes, 'st-ses-user')?.description, '@octocat');
  assert.equal(find(nodes, 'st-ses-ref')?.description, 'uatu-audit/octocat/u-1');
  assert.match(find(nodes, 'st-mon-clip')!.description!, /> 15 car\. · cifrado · 1 registrada/);
  assert.equal(find(nodes, 'st-mon-focus')?.description, 'en foco · fuera 1 min 30 s');
  assert.equal(find(nodes, 'st-mon-ext-github.copilot')?.description, 'activa');
  assert.equal(find(nodes, 'st-mon-ext-continue.continue')?.description, 'no instalada');
  assert.match(find(nodes, 'st-mon-ext')!.description!, /1 detectada/);
  assert.equal(find(nodes, 'st-mon-hb')?.description, 'cada 120 s · último hace 5 min');
  assert.equal(find(nodes, 'st-sync')?.description, '1 lote(s) pendiente(s)');
  assert.equal(find(nodes, 'st-sync-error')?.description, 'sin red');
  assert.equal(find(nodes, 'st-sync-retry')?.description, 'en 1 min (intento 2)');
  assert.equal(find(nodes, 'st-exam-registry')?.description, 'raw.githubusercontent.com');
});

test('estado: en espera, inactivo y error', () => {
  const standby = buildStatusTree(snapshot({ phase: 'standby', nowMs: T0 - 3_600_000 - 90 * 60_000, session: undefined, monitors: undefined }));
  assert.equal(standby[0].label, 'Esperando inicio');
  assert.equal(standby[0].description, 'inicia en 1 h 30 min');
  assert.equal(find(standby, 'st-session'), undefined);
  assert.equal(find(standby, 'st-monitors')?.description, 'detenidos');

  const idle = buildStatusTree({ nowMs: 0, phase: 'idle', clock: { source: 'local', offsetMs: 0 }, events: [], batches: [] });
  assert.deepEqual(idle.map((n) => n.label), ['Inactivo', 'Reloj']);
  const err = buildStatusTree({ nowMs: 0, phase: 'error', message: 'firma inválida', clock: { source: 'local', offsetMs: 45_000 }, events: [], batches: [] });
  assert.equal(err[0].description, 'firma inválida');
  assert.equal(err[1].color, 'charts.yellow', 'desfase de reloj relevante');
});

test('bitácora por lote: pendientes primero y lotes del más nuevo al más viejo', () => {
  const nodes = buildLogTree(snapshot(), 'batch');
  assert.deepEqual(nodes.map((n) => n.label), ['Pendientes de lote', 'Lote 1', 'Lote 0']);
  assert.equal(nodes[1].description, '2 evento(s) · sin sincronizar');
  assert.equal(nodes[1].icon, 'cloud-upload');
  assert.equal(nodes[2].description, '3 evento(s) · sincronizado');
  const paste = nodes[2].children![1];
  assert.equal(paste.label, '13:01:00  Pegado del portapapeles');
  assert.equal(paste.description, 'src/a.c · 85 car.');
  assert.equal(paste.contextValue, 'uatu.event');
  assert.equal(paste.eventSeq, 1);
  assert.match(paste.tooltip!, /\| Estado \| sincronizado \(lote 0\) \|/);
  assert.equal(find(paste.children!, 'ev-1-encrypted_payload')?.description, 'X25519-AES-256-GCM · 3 B cifrados');
  assert.equal(find(paste.children!, 'ev-1-range')?.description, 'L3:1 → L6:2');
});

test('bitácora por tipo y cronológica', () => {
  const byType = buildLogTree(snapshot(), 'type');
  assert.equal(byType[0].label, 'Foco de ventana');
  assert.equal(byType[0].description, '2');
  assert.deepEqual(byType[0].children!.map((c) => c.label.split('  ')[1]), ['Foco recuperado', 'Foco perdido']);
  const byTime = buildLogTree(snapshot(), 'time');
  assert.equal(byTime.length, 6);
  assert.match(byTime[0].description!, /registrado$/);
  assert.equal(byTime[0].label, '13:05:00  Latido');
  assert.deepEqual(buildLogTree(snapshot({ events: [] }), 'batch'), []);
});

test('resúmenes y detalle del evento', () => {
  const s = snapshot();
  assert.equal(summarizeEvent(s.events[3].event), 'fuera 1 min 30 s · total 1 min 30 s');
  assert.equal(summarizeEvent(s.events[4].event), 'github.copilot (activa)');
  const detail = JSON.parse(renderEventDetail(s.events[1]));
  assert.equal(detail._uatu.hash, computeEventHash(s.events[1].event));
  assert.equal(detail._uatu.estado, 'sincronizado');
  assert.equal(detail.data.char_count, 85);
});
