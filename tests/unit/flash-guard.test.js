// tests/unit/flash-guard.test.js
import test from 'node:test';
import assert from 'node:assert';
import { HdFlashGuard, StrobeLampGuard } from '../../src/shared/effects/flash-guard.ts';

test('a second bright rise inside 350 ms is zeroed; after it, allowed', () => {
  const g = new HdFlashGuard(350);
  assert.strictEqual(g.apply(0, 1, 0), 1);
  assert.strictEqual(g.apply(0, 0, 100), 0);
  assert.strictEqual(g.apply(0, 1, 200), 0, 'zeroed');
  assert.strictEqual(g.apply(0, 1, 400), 1, 'allowed again');
});

test('dim rises never count, and lamps are independent', () => {
  const g = new HdFlashGuard(350);
  g.apply(0, 1, 0); g.apply(0, 0, 50);
  assert.strictEqual(g.apply(0, 0.5, 100), 0.5);
  assert.strictEqual(g.apply(1, 1, 100), 1);
});

test('interval 0 disables the guard', () => {
  const g = new HdFlashGuard(0);
  g.apply(0, 1, 0); g.apply(0, 0, 10);
  assert.strictEqual(g.apply(0, 1, 20), 1);
});

test('threshold is inclusive and a suppressed rise remains suppressed until exactly the interval', () => {
  const g = new HdFlashGuard(350);
  assert.strictEqual(g.apply(0, 0.55, 0), 0.55);
  assert.strictEqual(g.apply(0, 0.8, 10), 0.8, 'held brightness is not a new rise');
  assert.strictEqual(g.apply(0, 0.549, 20), 0.549);
  assert.strictEqual(g.apply(0, 0.55, 349), 0);
  assert.strictEqual(g.apply(0, 0.55, 350), 0.55, 'blocked requests never move the last accepted rise');
  assert.strictEqual(g.apply(0, 0.6, 351), 0.6);
});

test('reset forgets each lamp and custom intervals use milliseconds', () => {
  const g = new HdFlashGuard(100);
  g.apply(0, 1, 1000); g.apply(0, 0, 1010);
  assert.strictEqual(g.apply(0, 1, 1099), 0);
  assert.strictEqual(g.apply(0, 1, 1100), 1);
  g.apply(0, 0, 1110);
  g.reset();
  assert.strictEqual(g.apply(0, 1, 1111), 1);
});

// The renderer keeps one guard while the setting changes and while other
// layers win a lamp between two of Hue Dynamics' rises.
test('a new interval applies from the next rise and keeps every lamp\'s history', () => {
  const g = new HdFlashGuard(350);
  g.apply(0, 1, 0); g.apply(0, 0, 50);
  g.setInterval(100);
  assert.strictEqual(g.apply(0, 1, 99), 0, 'the rise at 0 still counts');
  assert.strictEqual(g.apply(0, 1, 100), 1);
  g.apply(0, 0, 150);
  g.setInterval(0);
  assert.strictEqual(g.apply(0, 1, 151), 1, '0 turns it off');
  g.setInterval(350);
  g.apply(0, 0, 160);
  assert.strictEqual(g.apply(0, 1, 300), 0, 'the history survived the off spell: the rise at 100 counts');
  assert.strictEqual(g.apply(0, 1, 450), 1);
  assert.throws(() => g.setInterval(-1));
  assert.throws(() => g.setInterval(NaN));
});

test('another layer\'s frame ends a held rise without spending one, and is free on a lamp the guard never saw', () => {
  const g = new HdFlashGuard(350);
  assert.strictEqual(g.apply(0, 1, 0), 1);
  g.clear(0);
  assert.strictEqual(g.apply(0, 1, 100), 0, 'back from the other layer bright: a new rise, refused');
  assert.strictEqual(g.apply(0, 1, 350), 1, 'the refused rise never moved the last one');
  g.clear(7);
  assert.strictEqual(g.size, 1, 'clearing an unseen lamp keeps nothing for it');
});

test('the guard counts the lamps it holds bright, so a caller can tell when there is nothing to watch', () => {
  const g = new HdFlashGuard(350);
  g.apply(0, 1, 0); g.apply(1, 1, 0); g.apply(2, 0.2, 0);
  assert.strictEqual(g.brightCount, 2);
  g.apply(0, 0.1, 10);
  g.clear(1); g.clear(1); g.clear(9);
  assert.strictEqual(g.brightCount, 0);
  g.apply(0, 1, 400);
  g.reset();
  assert.strictEqual(g.brightCount, 0);
});

test('a clone keeps the interval and every lamp\'s history, and goes its own way after', () => {
  const g = new HdFlashGuard(350);
  g.apply(0, 1, 0);
  g.apply(1, 1, 100);
  g.apply(1, 0, 150);
  const c = g.clone();
  assert.strictEqual(c.brightCount, 1);
  assert.strictEqual(c.size, 2);
  assert.strictEqual(c.apply(1, 1, 300), 0, 'lamp 1 rose at 100: still inside the interval');
  assert.strictEqual(c.apply(1, 1, 460), 1);
  c.clear(0);
  assert.strictEqual(g.brightCount, 1, 'the original keeps its lamp 0 held');
  assert.strictEqual(g.apply(1, 1, 300), 0);
  g.setInterval(100);
  assert.strictEqual(c.apply(0, 1, 340), 0, 'the clone keeps its own interval');
});

// ── The strobe's permit per lamp ────────────────────────────────────────────

test('the strobe guard admits a lamp\'s rises eight frames apart and five in any forty-four, whoever draws them', () => {
  const g = new StrobeLampGuard();
  assert.strictEqual(g.apply(0, 1, 0), 1, 'the first rise');
  assert.strictEqual(g.apply(0, 1, 1), 1, 'held: no new rise');
  assert.strictEqual(g.apply(0, 0, 5), 0);
  assert.strictEqual(g.apply(0, 1, 7), 0, 'seven frames after the last rise: refused');
  assert.strictEqual(g.apply(0, 1, 8), 0, 'and the flash refused stays down, not shown late');
  assert.strictEqual(g.apply(0, 0, 9), 0);
  assert.strictEqual(g.apply(0, 1, 10), 1, 'a new flash, ten frames after the last rise shown');
  // Five rises by frame 34: a sixth inside the window of 44 from the first of them waits.
  for (const f of [18, 26, 34]) { g.apply(0, 0, f - 1); assert.strictEqual(g.apply(0, 1, f), 1, `frame ${f}`); }
  g.apply(0, 0, 41);
  assert.strictEqual(g.apply(0, 1, 42), 0, 'the sixth in 44 frames');
  g.apply(0, 0, 43);
  assert.strictEqual(g.apply(0, 1, 44), 1, 'forty-four frames after the first');
  // Another lamp has its own count.
  assert.strictEqual(g.apply(1, 1, 45), 1);
});

test('the strobe guard: a refused lamp only dims, the same frame drawn twice is one rise, another layer on the lamp keeps its rises', () => {
  const g = new StrobeLampGuard();
  // A Hue lamp pulsed: full, falling to its floor; a rise refused holds it at what it showed.
  assert.strictEqual(g.apply(0, 1, 0), 1);
  assert.strictEqual(g.apply(0, 0.4, 3), 0.4);
  assert.strictEqual(g.apply(0, 1, 4), 0.4, 'refused: no brighter than it was');
  assert.strictEqual(g.apply(0, 0.6, 5), 0.4);
  assert.strictEqual(g.apply(0, 0.2, 6), 0.2, 'it still dims');
  assert.strictEqual(g.apply(0, 1, 8), 1, 'the next flash, admitted');
  assert.strictEqual(g.apply(0, 1, 8), 1, 'the frame drawn again');
  // Another effect draws the lamp: the strobe coming back is a rise, counted from the last.
  g.clear(0);
  assert.strictEqual(g.liveCount, 0);
  assert.strictEqual(g.apply(0, 1, 12), 0, 'four frames after the last rise');
  g.clear(0);
  assert.strictEqual(g.apply(0, 1, 16), 1);
  assert.strictEqual(g.liveCount, 1);
  // A copy keeps its own history.
  const copy = g.clone();
  copy.apply(0, 0, 20);
  assert.strictEqual(copy.apply(0, 1, 30), 1);
  g.apply(0, 0, 20);
  assert.strictEqual(g.apply(0, 1, 22), 0, 'the original counts from its own last rise');
  g.reset();
  assert.strictEqual(g.apply(0, 1, 23), 1, 'reset: no history');
});
