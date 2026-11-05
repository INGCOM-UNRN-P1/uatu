import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ManifestError, PaquetesSettings, parseManifest } from '../src/config/manifest';
import { abrirPaquete, ARCHIVO_CLAVE, ARCHIVO_PAQUETE, AperturaPaquete, hashPaquete } from '../src/core/paquete';
import { baseManifest, tmpDir } from './helpers';

const START = Date.parse('2026-09-24T13:00:00Z');
const FIN = Date.parse('2026-09-24T15:00:00Z');
const AAD = (usuario: string, sha: string) => Buffer.from(`uatu-paquete-v1:${usuario}:${sha}`, 'utf8');

/** Paquete sellado como `uatu_tools.paquetes.sellar`. */
function sellar(usuario: string, archivos: Record<string, string>, clave = crypto.randomBytes(32)) {
  const mapa = new Map(Object.entries(archivos).map(([r, c]) => [r, Buffer.from(c)]));
  const sha256 = hashPaquete(usuario, mapa);
  const plano = JSON.stringify(Object.fromEntries([...mapa].map(([r, c]) => [r, c.toString('base64')])));
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, nonce);
  c.setAAD(AAD(usuario, sha256));
  const datos = Buffer.concat([c.update(plano, 'utf8'), c.final(), c.getAuthTag()]);
  return {
    clave,
    sha256,
    paquete: { formato: 'uatu-paquete-v1', algoritmo: 'AES-256-GCM', usuario, sha256, nonce: nonce.toString('base64'), datos: datos.toString('base64') },
  };
}

function escenario(usuario = 'ana', archivos: Record<string, string> = { 'examen.pdf': '%PDF tema 1' }) {
  const repoRoot = tmpDir('uatu-paquete-');
  const s = sellar(usuario, archivos);
  fs.writeFileSync(path.join(repoRoot, ARCHIVO_PAQUETE), JSON.stringify(s.paquete));
  fs.writeFileSync(path.join(repoRoot, ARCHIVO_CLAVE), `${s.clave.toString('base64')}\n`);
  const settings: PaquetesSettings = { carpeta: 'consigna', hashes: { [usuario]: s.sha256 } };
  const apertura: AperturaPaquete = { repoRoot, settings, usuario, nowMs: START + 60_000, startMs: START, deadlineMs: FIN, relojCalibrado: true };
  return { ...s, repoRoot, settings, apertura };
}

test('coincide con el vector de uatu-tools', () => {
  // Mismos valores que tests/test_paquetes.py de uatu-tools.
  const repoRoot = tmpDir('uatu-paquete-');
  const sha256 = 'b322f83db9bc4fe55775563853be533090479402006f12872400c42e14e5e866';
  fs.writeFileSync(
    path.join(repoRoot, ARCHIVO_PAQUETE),
    JSON.stringify({ formato: 'uatu-paquete-v1', usuario: 'ana', sha256, nonce: 'AAECAwQFBgcICQoL', datos: 'PCC3NbGdtjm3YbXq9tALNNK5uhaNAAt/59YO53QptUdUX3hf4g==' })
  );
  fs.writeFileSync(path.join(repoRoot, ARCHIVO_CLAVE), Buffer.from([...Array(32).keys()]).toString('base64'));
  const r = abrirPaquete({ repoRoot, settings: { carpeta: 'consigna', hashes: { ana: sha256 } }, usuario: 'Ana', nowMs: START, startMs: START, deadlineMs: FIN, relojCalibrado: true });
  assert.equal(r.estado, 'abierto');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'consigna', 'a.txt'), 'utf8'), 'hola\n');
});

test('sin la clave o sin el paquete queda pendiente y no escribe nada', () => {
  const e = escenario();
  fs.rmSync(path.join(e.repoRoot, ARCHIVO_CLAVE));
  assert.deepEqual(abrirPaquete(e.apertura), { estado: 'pendiente' });
  assert.equal(fs.existsSync(path.join(e.repoRoot, 'consigna')), false);
});

test('rechaza a otro usuario, sin descifrar', () => {
  const e = escenario();
  assert.deepEqual(abrirPaquete({ ...e.apertura, usuario: 'beto' }), { estado: 'rechazado', motivo: 'usuario_sin_paquete' });
  const conOtro = { ...e.settings, hashes: { ...e.settings.hashes, beto: 'a'.repeat(64) } };
  assert.deepEqual(abrirPaquete({ ...e.apertura, settings: conOtro, usuario: 'beto' }), { estado: 'rechazado', motivo: 'paquete_de_otro' });
  assert.equal(fs.existsSync(path.join(e.repoRoot, 'consigna')), false);
});

test('con reloj calibrado rechaza fuera de la ventana', () => {
  const e = escenario();
  assert.deepEqual(abrirPaquete({ ...e.apertura, nowMs: START - 1 }), { estado: 'rechazado', motivo: 'fuera_de_hora' });
  assert.deepEqual(abrirPaquete({ ...e.apertura, nowMs: FIN + 1 }), { estado: 'rechazado', motivo: 'fuera_de_hora' });
});

test('sin reloj calibrado manda la clave, no la hora local', () => {
  const e = escenario();
  assert.equal(abrirPaquete({ ...e.apertura, nowMs: START - 1, relojCalibrado: false }).estado, 'abierto');
});

test('rechaza una clave incorrecta y un paquete que no es el firmado', () => {
  const e = escenario();
  fs.writeFileSync(path.join(e.repoRoot, ARCHIVO_CLAVE), crypto.randomBytes(32).toString('base64'));
  assert.deepEqual(abrirPaquete(e.apertura), { estado: 'rechazado', motivo: 'clave_incorrecta' });
  const otro = sellar('ana', { 'examen.pdf': 'otro tema' });
  fs.writeFileSync(path.join(e.repoRoot, ARCHIVO_PAQUETE), JSON.stringify(otro.paquete));
  fs.writeFileSync(path.join(e.repoRoot, ARCHIVO_CLAVE), otro.clave.toString('base64'));
  assert.deepEqual(abrirPaquete(e.apertura), { estado: 'rechazado', motivo: 'paquete_no_sellado' });
  fs.writeFileSync(path.join(e.repoRoot, ARCHIVO_PAQUETE), 'no es json');
  assert.deepEqual(abrirPaquete(e.apertura), { estado: 'rechazado', motivo: 'paquete_no_sellado' });
});

for (const ruta of ['../fuera.txt', 'a/../../fuera.txt', '/etc/x', '.git/hooks/pre-commit', 'a\\..\\b', 'c:/x']) {
  test(`no escribe fuera de la carpeta: ${ruta}`, () => {
    const e = escenario('ana', { [ruta]: 'x' });
    assert.deepEqual(abrirPaquete(e.apertura), { estado: 'rechazado', motivo: 'ruta_invalida' });
    assert.equal(fs.existsSync(path.join(e.repoRoot, 'consigna')), false);
  });
}

test('al volver a entrar no pisa lo que el estudiante editó', () => {
  const e = escenario('ana', { 'examen.pdf': 'tema', 'plantilla.c': 'int main(void);\n' });
  const primero = abrirPaquete(e.apertura);
  assert.deepEqual(primero.estado === 'abierto' && primero.escritos.sort(), ['examen.pdf', 'plantilla.c']);
  const editado = path.join(e.repoRoot, 'consigna', 'plantilla.c');
  fs.writeFileSync(editado, 'mi solución');
  fs.rmSync(path.join(e.repoRoot, 'consigna', 'examen.pdf'));
  const segundo = abrirPaquete(e.apertura);
  assert.deepEqual(segundo.estado === 'abierto' && [segundo.escritos, segundo.conservados], [['examen.pdf'], ['plantilla.c']]);
  assert.equal(fs.readFileSync(editado, 'utf8'), 'mi solución');
});

test('el manifiesto valida el bloque paquetes', () => {
  const hashes = { ana: 'a'.repeat(64) };
  assert.deepEqual(parseManifest(JSON.stringify(baseManifest({ paquetes: { hashes } }))).manifest.paquetes, { carpeta: 'consigna', hashes });
  for (const malo of [
    { paquetes: { hashes: {} } },
    { paquetes: { hashes: { Ana: 'a'.repeat(64) } } },
    { paquetes: { hashes: { ana: 'xyz' } } },
    { paquetes: { carpeta: '../fuera', hashes } },
    { paquetes: { hashes }, consigna: { sha256: 'a'.repeat(64) } },
  ]) {
    assert.throws(() => parseManifest(JSON.stringify(baseManifest(malo))), ManifestError);
  }
});
