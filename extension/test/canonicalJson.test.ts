import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { canonicalStringify, CanonicalJsonError, omitKey } from '../src/core/canonicalJson';

test('ordena claves recursivamente y omite espacios', () => {
  const value = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } };
  assert.equal(canonicalStringify(value), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
});

test('no escapa caracteres no ASCII y escapa controles como Python', () => {
  assert.equal(canonicalStringify({ s: 'ñandú "q" \\ \n\t\u0001' }), '{"s":"ñandú \\"q\\" \\\\ \\n\\t\\u0001"}');
});

test('rechaza flotantes y valores no finitos', () => {
  assert.throws(() => canonicalStringify({ x: 1.5 }), CanonicalJsonError);
  assert.throws(() => canonicalStringify({ x: Number.NaN }), CanonicalJsonError);
  assert.throws(() => canonicalStringify({ x: 2 ** 60 }), CanonicalJsonError);
});

test('ignora claves con undefined y normaliza -0', () => {
  assert.equal(canonicalStringify({ a: undefined, b: -0 }), '{"b":0}');
});

test('omitKey no muta el original', () => {
  const src = { a: 1, signature: 'x' };
  const out = omitKey(src, 'signature');
  assert.deepEqual(out, { a: 1 });
  assert.equal(src.signature, 'x');
});
