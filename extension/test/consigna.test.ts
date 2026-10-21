import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ManifestError, parseManifest } from '../src/config/manifest';
import { consignaTreeHash } from '../src/core/consigna';
import { baseManifest } from './helpers';

test('el hash de la consigna coincide con el de uatu-admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uatu-consigna-'));
  assert.equal(consignaTreeHash(dir), undefined);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hola\n');
  // Mismo valor fijo que tests/test_consigna.py de uatu-tools.
  assert.equal(consignaTreeHash(dir), '7859017c979648d0896746364a6308bc0a38c80316cb57447475e34bbc4aae85');
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'base.c'), 'int main(void){return 0;}\n');
  assert.notEqual(consignaTreeHash(dir), '7859017c979648d0896746364a6308bc0a38c80316cb57447475e34bbc4aae85');
  assert.equal(consignaTreeHash(path.join(dir, 'no-existe')), undefined);
});

test('el manifiesto acepta y valida el bloque consigna', () => {
  const ok = parseManifest(JSON.stringify(baseManifest({ consigna: { sha256: 'a'.repeat(64) } })));
  assert.deepEqual(ok.manifest.consigna, { carpeta: 'consigna', sha256: 'a'.repeat(64) });
  assert.equal(parseManifest(JSON.stringify(baseManifest())).manifest.consigna, undefined);
  assert.throws(() => parseManifest(JSON.stringify(baseManifest({ consigna: { sha256: 'xyz' } }))), ManifestError);
  assert.throws(
    () => parseManifest(JSON.stringify(baseManifest({ consigna: { carpeta: '../fuera', sha256: 'a'.repeat(64) } }))),
    ManifestError
  );
});
