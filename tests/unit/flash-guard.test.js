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
