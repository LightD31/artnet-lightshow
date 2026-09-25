// The look kept for a restart (src/server/look-store.ts): what is saved and
// when, what is put back — never an energy effect — and where a show on its
// own clock has got to.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LookStore, currentLook, putBack, resumeAt } from '../../src/server/look-store.ts';
import { state } from '../../src/server/state.ts';
import { applyPatch, applyOverride } from '../../src/server/patch.ts';
import { stopEngine } from '../../src/server/engine.ts';

// applyPatch re-arms the beat timer, which would otherwise keep this process up.
test.after(() => stopEngine());

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'look.json');
}

const show = (over = {}) => ({
  running: true, analysisKey: 'file:/music/a.wav:1:2', track: { name: 'A', artist: 'B' }, getPositionMs: () => 61_234.6, ...over,
});

test('the look now: what a cue captures, and the auto show when it is running', () => {
  applyPatch({ pattern: 'solid', colorA: 3, masterDimmer: 200 });
  const idle = currentLook(null);
  assert.equal(idle.look.pattern, 'solid');
  assert.equal(idle.look.colorA, 3);
  assert.equal(idle.auto, null);
  assert.equal(currentLook(show({ running: false })).auto, null, 'a stopped show is not resumed');

  const timer = currentLook(show(), 'timer').auto;
  assert.deepEqual(timer, { running: true, key: 'file:/music/a.wav:1:2', track: { name: 'A', artist: 'B' }, source: 'timer', positionMs: 61_235 });
  assert.equal(currentLook(show(), 'spotify').auto.positionMs, null, 'a player-driven show follows the player');
});

test('saved when it changes, read back, and a file that is not a look is moved aside', (t) => {
  const file = place(t);
  const store = new LookStore(file);
  assert.equal(store.load(), undefined, 'nothing saved yet');
  const look = currentLook(show(), 'spotify');
  assert.equal(store.save(look), true);
  assert.equal(store.save(look), false, 'unchanged, not written again');
  const saved = new LookStore(file).load();
  assert.deepEqual(saved.look, look.look);
  assert.deepEqual(saved.auto, look.auto);
  assert.ok(Date.parse(saved.savedAt) <= Date.now());

  t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(file, JSON.stringify({ look: { pattern: 7 } }));
  assert.equal(new LookStore(file).load(), undefined);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.invalid-')));
});

test('put back: the look and its overrides, but never an energy effect', () => {
  const id = state.fixtures[0].id;
  applyPatch({ pattern: 'chase', colorB: 5, masterBlackout: false, energyOverride: 'white-strobe' });
  applyOverride(id, { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });
  const saved = { savedAt: new Date().toISOString(), ...currentLook(null) };
  assert.equal(saved.look.energyOverride, 'white-strobe');

  applyPatch({ pattern: 'solid', colorB: 1, energyOverride: null });
  applyOverride(id, null);
  putBack(saved);
  assert.equal(state.pattern, 'chase');
  assert.equal(state.colorB, 5);
  assert.equal(state.fixtures.find((f) => f.id === id).override.r, 255);
  assert.equal(state.energyOverride, null, 'a held strobe does not come back stuck on');
  applyOverride(id, null);
});

test('a show on its own clock resumes where the music has got to', () => {
  const savedAt = new Date(10_000).toISOString();
  const saved = (auto) => ({ savedAt, look: {}, auto });
  assert.equal(resumeAt(saved({ positionMs: 60_000 }), 13_500), 63_500, 'saved, plus the time since');
  assert.equal(resumeAt(saved({ positionMs: null })), null);
  assert.equal(resumeAt(saved(null)), null);
  assert.equal(resumeAt(saved({ positionMs: 5000 }), 9000), 5000, 'a clock that went backwards adds nothing');
});
