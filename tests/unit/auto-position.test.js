import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleAutoPosition } from '../../src/server/auto-position.js';

function show(overrides = {}) {
  return {
    running: true,
    timelineRevision: 'one',
    getPositionMs: () => 1000,
    ...overrides,
  };
}

test('a first position sample is held until the next clock update', () => {
  const first = sampleAutoPosition(show());
  assert.equal(first.positionMs, 1000);
  assert.equal(first.advancing, false);

  const next = sampleAutoPosition(show({ getPositionMs: () => 1010 }), first);
  assert.equal(next.advancing, true);
});

test('a paused or stopped source never advances the browser clock', () => {
  const paused = sampleAutoPosition(show({ running: true, getPositionMs: () => 1000 }), {
    positionMs: 1000, revision: 'one',
  });
  assert.equal(paused.advancing, false);

  const stopped = sampleAutoPosition(show({ running: false, getPositionMs: () => 1500 }), paused);
  assert.equal(stopped.running, false);
  assert.equal(stopped.positionMs, 1000);
  assert.equal(stopped.advancing, false);
});

test('a new timeline resets position instead of inheriting the old track', () => {
  const next = sampleAutoPosition(show({ timelineRevision: 'two', getPositionMs: () => 50 }), {
    positionMs: 90000, revision: 'one',
  });
  assert.equal(next.positionMs, 50);
  assert.equal(next.advancing, false);
});
