import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeTimePhase, MAX_TIMER_DELAY_MS, TimeGate, TimePhase, TimerApi, TrustedClock } from '../src/session/timeGate';

const START = Date.parse('2026-09-24T13:00:00Z');
const DEADLINE = Date.parse('2026-09-24T16:00:00Z');

test('computeTimePhase respeta los límites inclusivos', () => {
  assert.equal(computeTimePhase(START - 1, START, DEADLINE), 'STANDBY');
  assert.equal(computeTimePhase(START, START, DEADLINE), 'ACTIVE');
  assert.equal(computeTimePhase(DEADLINE, START, DEADLINE), 'ACTIVE');
  assert.equal(computeTimePhase(DEADLINE + 1, START, DEADLINE), 'CONCLUDED');
});

class FakeTimers implements TimerApi {
  public now = 0;
  private seq = 0;
  public timeouts = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timeouts.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timeouts.delete(h as number);
  }
  setInterval() {
    return -1;
  }
  clearInterval() {}
  advanceTo(t: number) {
    for (;;) {
      const due = [...this.timeouts.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      this.timeouts.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = t;
  }
}

test('TimeGate agenda las transiciones STANDBY -> ACTIVE -> CONCLUDED', () => {
  const timers = new FakeTimers();
  timers.now = START - 60_000;
  const seen: Array<[TimePhase, TimePhase | undefined]> = [];
  const gate = new TimeGate({ now: () => timers.now }, START, DEADLINE, (p, prev) => seen.push([p, prev]), timers);
  gate.start();
  assert.deepEqual(seen, [['STANDBY', undefined]]);
  timers.advanceTo(START);
  assert.deepEqual(seen.at(-1), ['ACTIVE', 'STANDBY']);
  timers.advanceTo(DEADLINE + 10);
  assert.deepEqual(seen.at(-1), ['CONCLUDED', 'ACTIVE']);
  assert.equal(timers.timeouts.size, 0);
  gate.stop();
});

test('TimeGate recorta retardos mayores al máximo de setTimeout', () => {
  const timers = new FakeTimers();
  timers.now = START - 60 * 24 * 3600_000;
  const gate = new TimeGate({ now: () => timers.now }, START, DEADLINE, () => {}, timers);
  gate.start();
  const [entry] = [...timers.timeouts.values()];
  assert.equal(entry.at - timers.now, MAX_TIMER_DELAY_MS);
});

test('TrustedClock corrige solo desfases significativos', () => {
  let local = 1_000_000;
  const clock = new TrustedClock({ now: () => local });
  clock.calibrate(local + 800, local);
  assert.equal(clock.now(), local);
  const observed = clock.calibrate(local + 3_600_000, local);
  assert.equal(observed, 3_600_000);
  local += 10;
  assert.equal(clock.now(), local + 3_600_000);
});
