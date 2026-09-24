import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatHourMinuteUtc, parseUtc } from '../src/core/time';

test('parseUtc exige zona horaria explícita', () => {
  assert.equal(parseUtc('2026-09-24T13:00:00Z', 'x').toISOString(), '2026-09-24T13:00:00.000Z');
  assert.equal(parseUtc('2026-09-24T10:00:00-03:00', 'x').toISOString(), '2026-09-24T13:00:00.000Z');
  assert.throws(() => parseUtc('2026-09-24T13:00:00', 'x'));
  assert.throws(() => parseUtc('mañana', 'x'));
});

test('formatHourMinuteUtc', () => {
  assert.equal(formatHourMinuteUtc(new Date('2026-09-24T09:05:00Z')), '09:05');
});
