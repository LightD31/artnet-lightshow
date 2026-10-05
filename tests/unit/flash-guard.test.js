// tests/unit/flash-guard.test.js
import test from 'node:test';
import assert from 'node:assert';
import { HdFlashGuard } from '../../src/shared/effects/flash-guard.ts';

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
