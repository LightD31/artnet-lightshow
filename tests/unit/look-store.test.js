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
import { setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { settings } from '../../src/server/settings.ts';
import { presetById } from '../../src/shared/effects/index.ts';

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
  applyPatch({ pattern: 'chase', colorB: 5, masterBlackout: false, energyOverride: 'white-strobe', paletteOverride: ['#FF0000'] });
  applyOverride(id, { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });
  const saved = { savedAt: new Date().toISOString(), ...currentLook(null) };
  assert.equal(saved.look.energyOverride, 'white-strobe');

  applyPatch({ pattern: 'solid', colorB: 1, energyOverride: null, paletteOverride: null });
  applyOverride(id, null);
  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase');
  assert.equal(state.colorB, 5);
  assert.deepEqual(state.paletteOverride, [{ r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }], 'the colours over the effects too');
  assert.equal(state.fixtures.find((f) => f.id === id).override.r, 255);
  assert.equal(state.energyOverride, null, 'a held strobe does not come back stuck on');
  applyOverride(id, null);
  applyPatch({ paletteOverride: null });
});

// The settings are settings.json's: a look saved a moment before a change to
// them must not take the change back on a restart.
test('put back leaves the audio mode and the strobe\'s settings as they are saved', (t) => {
  const values = settings._values;
  t.after(() => { settings._values = values; });
  const saved = { savedAt: new Date().toISOString(), ...currentLook(null) };
  saved.look = { ...saved.look, audioMode: values.audio.mode === 'off' ? 'reactive' : 'off', strobe: { ...values.strobe, flashesPerSecond: 5 } };
  settings.save = () => assert.fail('nothing is written');
  try {
    assert.equal(putBack(saved), true);
  } finally {
    delete settings.save;
  }
  assert.equal(settings.get('audio.mode'), values.audio.mode);
  assert.deepEqual(settings.group('strobe'), values.strobe);
});

test('a show on its own clock resumes where the music has got to', () => {
  const savedAt = new Date(10_000).toISOString();
  const saved = (auto) => ({ savedAt, look: {}, auto });
  assert.equal(resumeAt(saved({ positionMs: 60_000 }), 13_500), 63_500, 'saved, plus the time since');
  assert.equal(resumeAt(saved({ positionMs: null })), null);
  assert.equal(resumeAt(saved(null)), null);
  assert.equal(resumeAt(saved({ positionMs: 5000 }), 9000), 5000, 'a clock that went backwards adds nothing');
});

// A restart must come up whatever it finds. An effect that waits for the
// photosensitivity acknowledgement (taken back after the look was saved)
// stays off, as an energy effect does, and the rest of the look comes back:
// its colours, its masters and its overrides.
test('put back never stops a restart: an effect the safety gate refuses stays off, the rest of the look comes back', (t) => {
  const values = settings._values;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false } };
  setEffectSource((id) => presetById(id)?.spec ?? null);
  const id = state.fixtures[0].id;
  t.after(() => {
    settings._values = values;
    setEffectSource(null);
    applyOverride(id, null);
    applyPatch({ masterBlackout: false });
  });
  const warn = t.mock.method(console, 'warn', () => {});
  applyPatch({ pattern: 'chase', colorB: 2, masterBlackout: false });
  applyOverride(id, null);
  const saved = { savedAt: new Date().toISOString(), ...currentLook(null) };
  const blackedOut = { enabled: true, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: true };
  saved.look = {
    ...saved.look, pattern: 'ldj.visualizer.flash', colorB: 6, masterBlackout: true,
    overrides: saved.look.overrides.map((o, i) => (i === 0 ? blackedOut : o)),
  };

  assert.equal(putBack(saved), true);
  assert.equal(state.pattern, 'chase', 'the pattern it started on');
  assert.deepEqual([state.colorB, state.masterBlackout], [6, true], 'the colours and the masters');
  assert.equal(state.fixtures.find((f) => f.id === id).override.blackout, true, 'and the overrides');
  assert.match(warn.mock.calls[0].arguments.join(' '), /without ldj\.visualizer\.flash: photosensitivity acknowledgement required/);

  // A look that cannot be put back at all is left out whole, and the server still starts.
  applyPatch({ colorB: 2, masterBlackout: false });
  assert.equal(putBack({ ...saved, look: { ...saved.look, pattern: '' } }), false);
  assert.deepEqual([state.pattern, state.colorB, state.masterBlackout], ['chase', 2, false]);
  assert.match(warn.mock.calls.at(-1).arguments.join(' '), /could not put back/);
});
