// A patch names an effect by its preset id and the colours that play over
// every effect (src/server/patch.ts): the palette override is one to eight
// hex colours, and an effect that flashes faster than the photosensitivity
// threshold is refused before anything in the patch moves. An id nothing
// knows is still taken, as it always was.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPatch } from '../../src/server/patch.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { settings } from '../../src/server/settings.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';

// applyPatch re-arms the beat timer, which would otherwise hold the process open.
test.after(() => stopEngine());

/** The library as the engine's effect source, the acknowledgement as given, and the look put back after. */
function stage(t, acknowledged = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-effects-'));
  const library = new EffectLibrary(path.join(dir, 'effects.json')).load();
  setEffectSource((id) => library.resolve(id));
  const values = settings._values;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: acknowledged } };
  const before = { pattern: state.pattern, bpm: state.bpm, masterDimmer: state.masterDimmer, colorA: state.colorA, running: state.running };
  t.after(() => {
    settings._values = values;
    applyPatch({ ...before, paletteOverride: null });
    setEffectSource(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return library;
}

const statusOf = (status) => (err) => err.status === status;

test('palette overrides accept one to eight colours or null', (t) => {
  stage(t);
  applyPatch({ paletteOverride: ['#F00', '#00ff00', '#0000FF80'] });
  assert.deepEqual(state.paletteOverride, [
    { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 },
    { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 },
    { r: 0, g: 0, b: 255, w: 128, a: 0, uv: 0 },
  ]);
  assert.deepEqual(getLiveState().paletteOverride, ['#FF0000', '#00FF00', '#0000FF80'], 'hex on the wire, in one spelling');
  assert.deepEqual(renderInput().paletteOverride, state.paletteOverride, 'colours to the renderer');

  applyPatch({ paletteOverride: Array(8).fill('#FFFFFF') });
  assert.equal(state.paletteOverride.length, 8, 'eight, as many as an effect plays');
  applyPatch({ paletteOverride: ['#F00', '#00ff00', '#0000FF80'] });

  // An empty list is no clear command, and nothing but colours is a colour.
  for (const bad of [[], Array(9).fill('#FFFFFF'), ['random'], [{ random: true }], ['red'], '#FF0000']) {
    assert.throws(() => applyPatch({ paletteOverride: bad }), statusOf(400), JSON.stringify(bad));
  }
  assert.equal(getLiveState().paletteOverride.length, 3, 'a refused patch leaves it');

  applyPatch({ paletteOverride: null });
  assert.equal(state.paletteOverride, null);
  assert.equal(getLiveState().paletteOverride, null);
  assert.equal(renderInput().paletteOverride, null);
});

test('an effect that flashes too fast is refused before anything in the patch moves', (t) => {
  const library = stage(t);
  applyPatch({ pattern: 'ldj.FadeCycle', bpm: 120, masterDimmer: 255, colorA: 0, running: true });
  const before = {
    pattern: state.pattern, bpm: state.bpm, masterDimmer: state.masterDimmer, colorA: state.colorA,
    running: state.running, anchor: state.patternAnchor, fade: renderInput().fade, clock: conductor.status().bpm,
  };
  const now = () => ({
    pattern: state.pattern, bpm: state.bpm, masterDimmer: state.masterDimmer, colorA: state.colorA,
    running: state.running, anchor: state.patternAnchor, fade: renderInput().fade, clock: conductor.status().bpm,
  });

  assert.throws(() => applyPatch({ pattern: 'ldj.visualizer.flash', bpm: 140, masterDimmer: 10, colorA: 5, fadeMs: 2000, running: false }),
    (err) => err.status === 409);
  assert.deepEqual(now(), before, 'no fade, tempo, master, colour, run state or anchor moved');

  // A preset of one's own that says nothing of it is refused for its cadence.
  const fast = library.create({ name: 'Fast', spec: { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false } });
  assert.throws(() => applyPatch({ pattern: fast.id }), statusOf(409));
  assert.deepEqual(now(), before);

  // Whatever does not ask for such an effect goes ahead.
  applyPatch({ pattern: 'ldj.MatrixCycle' });
  assert.equal(state.pattern, 'ldj.MatrixCycle');
  applyPatch({ pattern: 'position-chase' });
  assert.equal(state.pattern, 'position-chase', 'a legacy look');
  applyPatch({ pattern: 'no-such-look' });
  assert.equal(state.pattern, 'no-such-look', 'an id nothing knows is taken, and plays nothing');
  assert.equal(renderInput().effect, null);
});

test('revoked acknowledgement refuses rapid effects without freezing the look', (t) => {
  stage(t, true);
  applyPatch({ pattern: 'ldj.visualizer.flash' });
  assert.equal(state.pattern, 'ldj.visualizer.flash');
  assert.equal(renderInput().effect.kind, 'ldj.visualizer');

  settings._values = { ...settings._values, safety: { ...settings._values.safety, photosensitivityAcknowledged: false } };
  // The renderer holds it dark now; a fader is not a new start.
  applyPatch({ masterDimmer: 100 });
  assert.equal(state.masterDimmer, 100);
  // Pressing it again is.
  assert.throws(() => applyPatch({ pattern: 'ldj.visualizer.flash', masterDimmer: 200 }), statusOf(409));
  assert.equal(state.masterDimmer, 100);
});
