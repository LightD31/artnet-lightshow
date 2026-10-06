import test from 'node:test';
import assert from 'node:assert';

import { VoiceManager } from '../../src/server/voices.ts';
import { MatrixBoard, MATRIX_KEY, MATRIX_LEASE_MS } from '../../src/server/matrix.ts';

const RED = '#FF0000';
const GREEN = '#00FF00';
const BLUE = '#0000FF';

/** A board over a real manager on the test's own clock, setTimeout mocked to match. */
function bench(t, { acknowledged = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now: 1000, acknowledged };
  const voices = new VoiceManager({
    now: () => c.now, beatPos: () => 0, bpm: () => 120, acknowledged: () => c.acknowledged, anyRunning: () => false,
  });
  const board = new MatrixBoard({ voices, now: () => c.now, acknowledged: () => c.acknowledged });
  const advance = (ms) => { c.now += ms; t.mock.timers.tick(ms); };
  const playing = () => voices.list().filter((v) => v.source === 'matrix' && voices.get(v.id).key === MATRIX_KEY);
  const spec = () => voices.get(playing()[0].id).spec;
  return { c, voices, board, advance, playing, spec };
}

test('two held cells make one pulses voice drawing from both colours; a third press restarts it with three', (t) => {
  const { board, playing, spec } = bench(t);
  board.setMode('pulses');
  board.press('a', RED);
  board.press('b', GREEN);
  assert.equal(playing().length, 1);
  const first = playing()[0];
  assert.equal(first.kind, 'ldj.matrixBoard');
  assert.equal(first.source, 'matrix');
  assert.deepStrictEqual(spec().params, { colours: [RED, GREEN], mode: 'pulses' });
  assert.deepStrictEqual(spec().palette, [RED, GREEN]);

  board.press('c', BLUE);
  assert.equal(playing().length, 1);
  assert.notEqual(playing()[0].id, first.id, 'a new instance');
  assert.deepStrictEqual(spec().params.colours, [RED, GREEN, BLUE]);
  assert.deepStrictEqual(board.status(), { mode: 'pulses', colours: [RED, GREEN, BLUE], voice: playing()[0].id });
});

test('repeated equal colours stay separate cells, a renewal restarts nothing, and a mode change restarts', (t) => {
  const { board, playing, spec } = bench(t);
  board.setMode('pulses');
  board.press('a', RED);
  board.press('b', RED);
  const id = playing()[0].id;
  assert.deepStrictEqual(spec().params.colours, [RED, RED]);
  board.press('a', RED);
  assert.equal(playing()[0].id, id, 'the same press again only renews');
  board.setMode('cycle');
  assert.notEqual(playing()[0].id, id);
  assert.equal(spec().params.mode, 'cycle');
});

test('release of the last cell ends the voice', (t) => {
  const { board, playing } = bench(t);
  board.press('a', RED);
  board.press('b', GREEN);
  board.release('a');
  assert.equal(playing().length, 1);
  board.release('b');
  assert.equal(playing().length, 0);
  assert.equal(board.status().voice, null);
});

test('a cell not renewed runs out by itself; the others play on without it', (t) => {
  const { board, advance, playing, spec } = bench(t);
  board.setMode('pulses');
  board.press('a', RED);
  advance(600);
  board.press('b', GREEN);
  advance(MATRIX_LEASE_MS - 600);
  assert.deepStrictEqual(spec().params.colours, [GREEN], 'a lapsed, b still held');
  advance(600);
  assert.equal(playing().length, 0);
});

test('a ninth cell is refused and changes nothing; an existing cell may still change', (t) => {
  const { board, spec } = bench(t);
  for (let i = 0; i < 8; i++) board.press(`t${i}`, RED);
  assert.throws(() => board.press('t8', BLUE), (err) => err.status === 400);
  assert.equal(spec().params.colours.length, 8);
  board.press('t0', BLUE);
  assert.equal(spec().params.colours[0], BLUE);
});

test('a rapid mode before the acknowledgement is refused atomically', (t) => {
  const { board, playing } = bench(t, { acknowledged: false });
  board.setMode('solid');
  board.press('a', RED);
  const id = playing()[0].id;
  assert.throws(() => board.setMode('flashes'), (err) => err.status === 409);
  assert.equal(board.status().mode, 'solid');
  assert.equal(playing()[0].id, id);
});

test('solid mode sets every lamp and ignores a second change inside 20 ms', (t) => {
  const { board, advance, playing, spec } = bench(t);
  board.setMode('solid');
  board.press('a', RED);
  const first = playing()[0];
  assert.equal(first.targets, 'shared', 'every lamp');
  assert.deepStrictEqual(spec().params, { colours: [RED], mode: 'solid' });

  advance(5);
  board.press('b', GREEN);
  advance(5);
  board.press('c', BLUE);
  assert.equal(playing()[0].id, first.id, 'inside 20 ms nothing restarts');
  assert.deepStrictEqual(spec().params.colours, [RED]);

  advance(10);
  assert.notEqual(playing()[0].id, first.id, 'the latest list, once, at 20 ms');
  assert.deepStrictEqual(spec().params.colours, [RED, GREEN, BLUE]);
  const second = playing()[0].id;
  advance(30);
  assert.equal(playing()[0].id, second, 'applied once');
});

test('the last release inside the 20 ms cancels the pending solid change', (t) => {
  const { board, advance, playing } = bench(t);
  board.setMode('solid');
  board.press('a', RED);
  advance(5);
  board.press('b', GREEN);
  board.release('a');
  board.release('b');
  assert.equal(playing().length, 0);
  advance(50);
  assert.equal(playing().length, 0);
});

test('a press for a token released within the lease does not bring the colour back', (t) => {
  const { board, advance, playing } = bench(t);
  board.setMode('pulses');
  board.press('a', RED);
  board.release('a');
  advance(100);
  assert.deepStrictEqual(board.press('a', RED).colours, [], 'a late renewal after the release is dropped');
  assert.equal(playing().length, 0);
  board.press('b', GREEN);
  assert.deepStrictEqual(board.status().colours, [GREEN], 'other tokens still hold');
  advance(MATRIX_LEASE_MS - 100);
  assert.deepStrictEqual(board.press('a', RED).colours, [GREEN, RED], 'the tombstone ends with the lease');
});

test('released-token tombstones stay bounded and expire', (t) => {
  const { board, advance } = bench(t);
  for (let i = 0; i < 1000; i++) { board.press(`t${i}`, RED); board.release(`t${i}`); }
  assert.ok(board._released.size <= 256, `kept ${board._released.size}`);
  advance(MATRIX_LEASE_MS + 1);
  board.press('x', RED);
  assert.equal(board._released.size, 0, 'expired tombstones are cleared');
});

/** As `bench`, with the manager telling the board of every change, as the server wires it. */
function wired(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now: 1000, acknowledged: true, ...options };
  let board = null;
  const voices = new VoiceManager({
    now: () => c.now, beatPos: () => 0, bpm: () => 120, acknowledged: () => c.acknowledged, anyRunning: () => false,
    onChange: () => board?.sync(),
  });
  board = new MatrixBoard({ voices, now: () => c.now, acknowledged: () => c.acknowledged });
  const advance = (ms) => { c.now += ms; t.mock.timers.tick(ms); };
  const playing = () => voices.list().filter((v) => v.source === 'matrix');
  return { c, voices, board, advance, playing };
}

test('letting go is never refused: with the acknowledgement taken back, held rapid cells stop playing, lapse and release as always', (t) => {
  const { c, board, advance, playing } = wired(t);
  board.setMode('pulses');
  board.press('a', RED);
  advance(600);
  board.press('b', GREEN);
  assert.equal(playing().length, 1);
  c.acknowledged = false;
  // The first lease runs out: no throw inside the timer, nothing rapid plays on, the other cell is still held.
  advance(MATRIX_LEASE_MS - 600);
  assert.deepStrictEqual(board.status(), { mode: 'pulses', colours: [GREEN], voice: null });
  assert.equal(playing().length, 0);
  // A renewal is a press, and a rapid press is refused; a release is not.
  assert.throws(() => board.press('b', GREEN), (err) => err.status === 409);
  assert.deepStrictEqual(board.release('b'), { mode: 'pulses', colours: [], voice: null });
  // And a cell left alone lapses by itself.
  c.acknowledged = true;
  board.press('c', BLUE);
  c.acknowledged = false;
  advance(MATRIX_LEASE_MS);
  assert.deepStrictEqual(board.status().colours, []);
  // A mode that needs no acknowledgement plays on without it.
  board.setMode('cycle');
  board.press('d', RED);
  assert.equal(playing().length, 1);
  board.release('d');
});

test('the board\'s voice stopped from outside takes the cells with it, and a finger still down does not start it again', (t) => {
  const { voices, board, advance, playing } = wired(t);
  board.setMode('cycle');
  board.press('a', RED);
  board.press('b', GREEN);
  assert.equal(playing().length, 1);
  voices.stopAll();
  assert.deepStrictEqual(board.status(), { mode: 'cycle', colours: [], voice: null }, 'stop-all, a disarm: the board is empty');
  // The fingers are still down and renewing: ignored for as long as they keep at it.
  for (let i = 0; i < 6; i++) {
    advance(400);
    assert.deepStrictEqual(board.press('a', RED).colours, []);
  }
  assert.equal(playing().length, 0);
  // Lifted and pressed again: a new press plays.
  board.release('a');
  advance(MATRIX_LEASE_MS);
  assert.deepStrictEqual(board.press('a', RED).colours, [RED]);
  assert.equal(playing().length, 1);
  // A finger that only went quiet for a lease may press again too.
  advance(MATRIX_LEASE_MS);
  assert.deepStrictEqual(board.press('b', GREEN).colours, [GREEN]);
  // The board changing its own voice (a third colour restarts it) is not a stop from outside.
  board.press('c', BLUE);
  assert.deepStrictEqual(board.status().colours, [GREEN, BLUE]);
  assert.equal(playing().length, 1);
});
