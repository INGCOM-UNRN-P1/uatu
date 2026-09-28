import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SettingRule } from '../src/config/manifest';
import { auditSettings, MAX_VALUE_JSON, SettingState, violatesRule } from '../src/monitors/settingsAudit';

// Reglas portadas de grid (N-GRID-01): `forbid` y `allow` con la misma semántica.
const REGLAS: SettingRule[] = [
  { key: 'github.copilot.enable', forbid: true, note: 'Sin IA durante el examen' },
  { key: 'editor.formatOnSave', allow: [true] },
];

test('violatesRule: forbid marca los valores verdaderos y allow los que no están en la lista', () => {
  assert.equal(violatesRule(REGLAS[0], true), true);
  assert.equal(violatesRule(REGLAS[0], { '*': true }), true);
  assert.equal(violatesRule(REGLAS[0], false), false);
  assert.equal(violatesRule(REGLAS[0], undefined), false);
  assert.equal(violatesRule(REGLAS[1], true), false);
  assert.equal(violatesRule(REGLAS[1], false), true);
  assert.equal(violatesRule(REGLAS[1], undefined), true);
  assert.equal(violatesRule({ key: 'x', allow: [{ a: 1 }] }, { a: 1 }), false);
});

test('auditSettings registra solo las transiciones: la violación y su corrección', () => {
  const previo = new Map<string, SettingState>();
  const valores: Record<string, unknown> = { 'github.copilot.enable': false, 'editor.formatOnSave': true };
  const leer = (k: string) => valores[k];

  // Cumple desde el principio: nada que registrar.
  assert.deepEqual(auditSettings(REGLAS, leer, previo), []);

  valores['github.copilot.enable'] = { '*': true };
  assert.deepEqual(auditSettings(REGLAS, leer, previo), [
    { key: 'github.copilot.enable', value_json: '{"*":true}', state: 'violated', note: 'Sin IA durante el examen' },
  ]);
  // Sin cambios: no se repite.
  assert.deepEqual(auditSettings(REGLAS, leer, previo), []);

  valores['github.copilot.enable'] = false;
  assert.deepEqual(auditSettings(REGLAS, leer, previo), [
    { key: 'github.copilot.enable', value_json: 'false', state: 'resolved', note: 'Sin IA durante el examen' },
  ]);
});

test('auditSettings acota los valores largos y registra los no canónicos como JSON', () => {
  const previo = new Map<string, SettingState>();
  const [f] = auditSettings([{ key: 'x.lista', allow: [[]] }], () => 'a'.repeat(500), previo);
  assert.equal(f.value_json.length, MAX_VALUE_JSON + 1);
  const [g] = auditSettings([{ key: 'editor.fontSize', allow: [14] }], () => 14.5, previo);
  assert.equal(g.value_json, '14.5');
});
