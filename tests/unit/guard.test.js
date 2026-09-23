// A throw inside a timer used to end the process, leaving every fixture
// latched on its last frame. The guard contains it and reports it — once per
// interval, not forty times a second.

import test from 'node:test';
import assert from 'node:assert';
import { guarded, report } from '../../src/server/guard.ts';

function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try { fn(); } finally { console.error = original; }
  return lines;
}

test('a guarded callback reports a throw instead of letting it escape', () => {
  let calls = 0;
  const tick = guarded('test-render', () => { calls++; throw new Error('bad frame'); });
  const lines = captureErrors(() => {
    assert.doesNotThrow(() => tick());
    assert.doesNotThrow(() => tick());
  });
  assert.strictEqual(calls, 2, 'the callback still runs every time');
  assert.strictEqual(lines.length, 1, 'but a repeating fault is reported once per interval');
  assert.match(lines[0], /\[test-render\].*bad frame/);
});

test('a guarded callback passes its return value and `this` through', () => {
  const obj = { n: 3, get: guarded('test-this', function get() { return this.n * 2; }) };
  assert.strictEqual(obj.get(), 6);
});

test('reports are rate-limited per place, not globally', () => {
  const lines = captureErrors(() => {
    report('place-a', new Error('a'));
    report('place-b', new Error('b'));
    report('place-a', new Error('a again'));
  });
  assert.strictEqual(lines.length, 2);
});
