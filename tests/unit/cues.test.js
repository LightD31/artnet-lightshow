import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CueStore, captureLook, recallLook, lookSchema, MAX_CUES } from '../../src/server/cues.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { applyPatch, applyOverride } from '../../src/server/patch.ts';
import { renderInput, setEffectSource, stopEngine } from '../../src/server/engine.ts';
import { settings } from '../../src/server/settings.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { conductor } from '../../src/server/conductor.ts';
import { makeGrid } from '../../src/shared/beat-clock.ts';

let dir;
let file;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cues-'));
  file = path.join(dir, 'cues.json');
});
test.afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// applyPatch re-arms the beat timer, which would otherwise hold the event loop
// open and keep this process running after the last assertion.
test.after(() => stopEngine());

function store() { return new CueStore(file).load(); }

test('a missing file is a fresh, empty stack rather than an error', () => {
  assert.deepStrictEqual(store().list(), []);
});

test('cues survive a reload', () => {
  const a = store();
  const cue = a.create({ name: 'Verse' });

  const b = store();
  assert.strictEqual(b.list().length, 1);
  assert.strictEqual(b.get(cue.id).name, 'Verse');
  assert.deepStrictEqual(b.get(cue.id).look, cue.look);
});

// A hand-edit that went wrong should not stop the show, and should not throw
// the operator's other cues away either.
test('a corrupt file is moved aside and the server starts with no cues', () => {
  fs.writeFileSync(file, '{ this is not json');
  const s = store();

  assert.deepStrictEqual(s.list(), []);
  const salvaged = fs.readdirSync(dir).filter((f) => f.includes('.invalid-'));
  assert.strictEqual(salvaged.length, 1, 'the bad file is kept for recovery');
});

test('a file that fails validation is quarantined, not loaded half-way', () => {
  fs.writeFileSync(file, JSON.stringify({ cues: [{ id: 'x', name: 'no look' }] }));
  const s = store();

  assert.deepStrictEqual(s.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.invalid-')));
});

// Renaming used to be the moment a carefully built look got replaced by
// whatever happened to be on stage.
test('a rename leaves the stored look alone', () => {
  const s = store();
  applyPatch({ pattern: 'chase', bpm: 128 });
  const cue = s.create({ name: 'Verse' });

  applyPatch({ pattern: 'strobe', bpm: 174 });
  s.update(cue.id, { name: 'Chorus' });

  assert.strictEqual(s.get(cue.id).name, 'Chorus');
  assert.strictEqual(s.get(cue.id).look.pattern, 'chase', 'the look is untouched');
  assert.strictEqual(s.get(cue.id).look.bpm, 128);
});

test('recapture overwrites the look with what is on stage now', () => {
  const s = store();
  applyPatch({ pattern: 'chase', bpm: 128 });
  const cue = s.create({ name: 'Verse' });

  applyPatch({ pattern: 'strobe', bpm: 174 });
  s.update(cue.id, { recapture: true });

  assert.strictEqual(s.get(cue.id).look.pattern, 'strobe');
  assert.strictEqual(s.get(cue.id).look.bpm, 174);
});

test('recall puts the whole look back, including per-fixture overrides', () => {
  applyPatch({ pattern: 'chase', bpm: 128, colorA: 2, masterDimmer: 200, strobeSpeed: 0 });
  applyOverride(0, { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 128, strobe: 0, blackout: false });
  const saved = captureLook();

  applyPatch({ pattern: 'rainbow', bpm: 90, colorA: 5, masterDimmer: 40 });
  applyOverride(0, null);
  applyOverride(1, { enabled: true, r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false });

  recallLook(saved);

  assert.strictEqual(state.pattern, 'chase');
  assert.strictEqual(state.bpm, 128);
  assert.strictEqual(state.colorA, 2);
  assert.strictEqual(state.masterDimmer, 200);
  assert.strictEqual(state.fixtures[0].override.r, 255, 'the saved override is restored');
  assert.strictEqual(state.fixtures[0].override.dim, 128);
  // A cue is the whole rig: a fixture the cue says nothing about must be
  // cleared, not left holding whatever the previous look put on it.
  assert.strictEqual(state.fixtures[1].override, null, 'fixtures outside the cue are cleared');

  applyOverride(0, null);
});

test('a look with the bars on a picture of their own comes back that way', () => {
  applyPatch({ pattern: 'hit', pixelPattern: 'impact', anchorMs: 0 });
  const saved = captureLook();
  assert.strictEqual(saved.pixelPattern, 'impact');
  applyPatch({ pattern: 'chase' });
  recallLook(saved);
  assert.deepStrictEqual([state.pattern, state.pixelPattern], ['hit', 'impact']);

  // A cue saved before the pars and the bars could run apart was one pattern
  // on the whole rig, and recalls as one.
  const { pixelPattern: _, ...older } = saved;
  recallLook(older);
  assert.deepStrictEqual([state.pattern, state.pixelPattern], ['hit', null]);
});

test('recall reports an unknown id instead of blacking the rig out', () => {
  const s = store();
  assert.strictEqual(s.recall('nope'), false);
  assert.strictEqual(s.remove('nope'), null);
  assert.strictEqual(s.update('nope', { name: 'x' }), null);
});

// Undo means "put that cue back", not "make a new one that looks like it": the
// delete answer has to carry enough to restore the id and the position.
test('delete hands back the cue it removed and where it was', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  s.create({ name: 'C' });

  const removed = s.remove(b.id);

  assert.strictEqual(removed.index, 1);
  assert.strictEqual(removed.cue.id, b.id);
  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'C']);
});

test('a restored cue keeps its id and goes back in its old slot', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  s.create({ name: 'C' });

  const { cue, index } = s.remove(b.id);
  s.insert(cue, index);

  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'B', 'C']);
  assert.strictEqual(s.list()[1].id, b.id, 'the same cue, not a copy');
});

// Pressing undo twice, or on a cue that has since been re-created, must not
// leave two rows claiming one id.
test('restoring a cue that is already there is refused, not duplicated', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  const { cue, index } = s.remove(a.id);

  assert.ok(s.insert(cue, index));
  assert.strictEqual(s.insert(cue, index), null, 'the second undo is a no-op');
  assert.strictEqual(s.list().length, 1);
});

test('a restore survives a reload, like any other write', () => {
  const a = store();
  const cue = a.create({ name: 'Verse' });
  const { cue: removed, index } = a.remove(cue.id);
  a.insert(removed, index);

  assert.deepStrictEqual(store().list().map((c) => c.name), ['Verse']);
});

// The index is a hint from a client that may be working from a stale list.
test('an out-of-range index clamps instead of throwing', () => {
  const s = store();
  s.create({ name: 'A' });
  const b = s.create({ name: 'B' });
  const { cue } = s.remove(b.id);

  s.insert(cue, 99);

  assert.deepStrictEqual(s.list().map((c) => c.name), ['A', 'B']);
});

test('a restore is validated like any other stored cue', () => {
  const s = store();
  assert.throws(() => s.insert({ id: 'x', name: 'no look' }, 0));
  assert.strictEqual(s.list().length, 0);
});

test('reorder follows the given order and keeps ids the caller left out', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  s.create({ name: 'B' });
  const c = s.create({ name: 'C' });

  // A stale client that has never seen C must not be able to drop it.
  s.reorder([c.id, a.id]);

  assert.deepStrictEqual(s.list().map((x) => x.name), ['C', 'A', 'B']);
});

test('reorder ignores ids that are not in the stack', () => {
  const s = store();
  const a = s.create({ name: 'A' });
  const b = s.create({ name: 'B' });

  s.reorder(['ghost', b.id, a.id]);

  assert.deepStrictEqual(s.list().map((x) => x.name), ['B', 'A']);
});

// Summaries ride every state broadcast, so they carry the swatch and nothing
// heavier — the per-fixture overrides stay on disk until someone asks.
test('summaries carry identity and a swatch, not the stored overrides', () => {
  const s = store();
  applyPatch({ colorA: 1, colorB: 2, colorC: 3, colorD: 4, pattern: 'chase' });
  s.create({ name: 'Verse' });

  const [summary] = s.summaries();
  assert.deepStrictEqual(Object.keys(summary).sort(),
    ['blackout', 'bpm', 'colors', 'id', 'name', 'pattern', 'updatedAt']);
  assert.deepStrictEqual(summary.colors, [1, 2, 3, 4]);
  assert.strictEqual(summary.pattern, 'chase');
});

test('the stack is capped so a stuck client cannot grow the file without bound', () => {
  const s = store();
  for (let i = 0; i < MAX_CUES; i++) s.create({ name: `Cue ${i}` });

  assert.throws(() => s.create({ name: 'one too many' }), /Cue stack is full/);
  assert.strictEqual(s.list().length, MAX_CUES);
});

// Nothing about the patch belongs in a look: recalling a cue must never
// re-address the rig or move a fixture to another universe mid-show.
test('a look holds no patch data', () => {
  const look = captureLook();
  for (const key of ['fixtures', 'artnet', 'profiles', 'universes']) {
    assert.strictEqual(look[key], undefined, `${key} must not be part of a cue`);
  }
});

// A cue saved in a quiet moment at 90 BPM must not drag a set that is locked
// to a 128 BPM song down to 90 — or take the clock off the song at all.
test('while the clock follows a song, recall keeps the song\'s tempo', () => {
  applyPatch({ pattern: 'rainbow', bpm: 90 });
  const saved = captureLook();

  let pos = 10000;
  conductor.setTrack({ key: 'song', grid: makeGrid(Array.from({ length: 512 }, (_, i) => i * (60 / 128))), positionMs: () => (pos += 25) });
  try {
    assert.strictEqual(conductor.now().source, 'track');
    applyPatch({ pattern: 'chase' });
    recallLook(saved);
    assert.strictEqual(state.pattern, 'rainbow', 'the look comes back');
    assert.strictEqual(conductor.now().source, 'track', 'the clock stays on the song');
  } finally {
    conductor.clearTrack();
  }
});

test('overwriting a cue answers with the look it replaced, and putting it back is an undo', async () => {
  const { default: express } = await import('express');
  const { attachRoutes } = await import('../../src/server/routes.ts');
  const s = store();
  applyPatch({ pattern: 'chase', colorA: 1 });
  const cue = s.create({ name: 'Verse' });
  const before = JSON.parse(JSON.stringify(s.get(cue.id).look));
  applyPatch({ pattern: 'strobe', colorA: 3 });

  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, cues: s });
  const server = await new Promise((r) => { const srv = app.listen(0, '127.0.0.1', () => r(srv)); });
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/cues/${cue.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => res.json());
  try {
    const over = await put({ recapture: true });
    assert.strictEqual(over.ok, true);
    assert.deepStrictEqual(over.previous, before, 'the look it had');
    assert.strictEqual(s.get(cue.id).look.pattern, 'strobe');
    const undo = await put({ look: over.previous });
    assert.strictEqual(undo.ok, true);
    assert.deepStrictEqual(s.get(cue.id).look, before, 'back as it was');
    assert.strictEqual((await put({ name: 'Chorus' })).previous, undefined, 'a rename replaces no look');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a cue is found by its name, case and surrounding space ignored', () => {
  const store = new CueStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cues-')), 'cues.json'));
  const cue = store.create({ name: 'Party', look: captureLook() });
  assert.equal(store.findByName(' party ')?.id, cue.id);
  assert.equal(store.findByName('Rave'), null);
  assert.equal(store.findByName(''), null);
});

// ─── The palette override, the audio mode, the strobe's settings ──────────
// What a cue keeps beside the look since effects: the colours played over
// every effect (as hex), how the effects take the music, and how the manual
// strobe flashes — its settings, never whether it is on.

/** Settings held in memory for a test: `save` stands in for the write, the values come back after. */
function holdSettings(t, save = () => {}) {
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings.save = save;
  t.after(() => {
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
  });
}

/** The look as it was, put back after the test. */
function holdLook(t) {
  const before = { pattern: state.pattern, colorA: state.colorA, energyOverride: state.energyOverride, heldEnergy: state.heldEnergy };
  t.after(() => {
    state.heldEnergy = before.heldEnergy;
    applyPatch({ pattern: before.pattern, colorA: before.colorA, energyOverride: before.energyOverride, paletteOverride: null });
  });
}

/** A library of the test's own as the engine's effect source. */
function library(t) {
  const lib = new EffectLibrary(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-effects-')), 'effects.json')).load();
  setEffectSource((id) => lib.resolve(id));
  t.after(() => setEffectSource(null));
  return lib;
}

test('a cue captures and recalls paletteOverride and audioMode; a cue captured while the strobe is latched stores energyOverride null', (t) => {
  holdSettings(t);
  holdLook(t);
  // Acknowledged: the strobe latches only then.
  settings.update({ audio: { mode: 'reactive' }, strobe: { flashesPerSecond: 4, palette: ['#FF0000', '#0000FF'] }, safety: { photosensitivityAcknowledged: true } });
  applyPatch({ pattern: 'chase', paletteOverride: ['#ff0000', '#0000FF'], energyOverride: 'palette-strobe' });
  const saved = captureLook();
  assert.deepStrictEqual(saved.paletteOverride, ['#FF0000', '#0000FF']);
  assert.strictEqual(saved.audioMode, 'reactive');
  assert.deepStrictEqual(saved.strobe, settings.group('strobe'));
  assert.strictEqual(saved.strobe.flashesPerSecond, 4);
  assert.strictEqual(saved.energyOverride, null, 'the strobe is not part of a look');
  assert.ok(lookSchema.safeParse(saved).success);

  // A latched energy effect is.
  applyPatch({ energyOverride: 'blinder' });
  assert.strictEqual(captureLook().energyOverride, 'blinder');

  applyPatch({ pattern: 'rainbow', paletteOverride: ['#00FF00'], energyOverride: null });
  settings.update({ audio: { mode: 'off' }, strobe: { flashesPerSecond: 2, palette: ['#FFFFFF'] } });
  recallLook(saved);
  assert.strictEqual(state.pattern, 'chase');
  assert.deepStrictEqual(getLiveState().paletteOverride, ['#FF0000', '#0000FF']);
  assert.strictEqual(settings.get('audio.mode'), 'reactive');
  assert.deepStrictEqual(settings.group('strobe'), saved.strobe, 'the strobe\'s settings come back');
  assert.strictEqual(state.energyOverride, null, 'and no strobe starts');
});

test('the cue file saved before this change (tests/fixtures/golden/cues-before.json) loads and every cue recalls its pattern and colours; the one with palette-strobe does not start the strobe', (t) => {
  holdSettings(t);
  holdLook(t);
  fs.copyFileSync(new URL('../fixtures/golden/cues-before.json', import.meta.url), file);
  const s = store();
  const looks = s.list();
  assert.deepStrictEqual(looks.map((c) => c.look.pattern), ['position-chase', 'halves', 'swirl']);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.invalid-')), 'nothing moved aside');

  settings.update({ audio: { mode: 'off' } });
  const strobe = settings.group('strobe');
  for (const cue of looks) {
    // What is on stage before: another look, colours over it, an energy effect latched.
    applyPatch({ pattern: 'rainbow', colorA: 3, colorB: 3, paletteOverride: ['#00FF00'], energyOverride: 'blinder' });
    assert.ok(s.recall(cue.id));
    const { look } = cue;
    assert.strictEqual(state.pattern, look.pattern);
    assert.deepStrictEqual([state.colorA, state.colorB, state.colorC, state.colorD], [look.colorA, look.colorB, look.colorC, look.colorD]);
    assert.strictEqual(state.paletteOverride, null, 'saved before there was an override: its own colours show');
    assert.strictEqual(settings.get('audio.mode'), 'off', 'an audio mode it never saved stays as it is');
    assert.deepStrictEqual(settings.group('strobe'), strobe);
  }
  const strobed = looks.find((c) => c.look.energyOverride === 'palette-strobe');
  assert.ok(strobed, 'the fixture has the cue saved with the strobe latched');
  state.heldEnergy = null;
  s.recall(strobed.id);
  assert.strictEqual(state.energyOverride, null, 'recalling it does not start the strobe');
  assert.notStrictEqual(renderInput().energy, 'palette-strobe');
  assert.strictEqual(state.pattern, 'swirl');
});

test('recallLook of a cue whose pattern is gone does not throw: the id stays, and plays nothing', (t) => {
  holdSettings(t);
  holdLook(t);
  const lib = library(t);
  const preset = lib.create({ name: 'Mine', spec: { kind: 'ldj.FadeCycle', params: { cadence: 2 } } });
  applyPatch({ pattern: preset.id });
  const saved = captureLook();
  lib.remove(preset.id);
  applyPatch({ pattern: 'chase' });
  recallLook(saved);
  assert.strictEqual(state.pattern, preset.id);
  assert.strictEqual(renderInput().effect, null);
});

test('a cue is refused whole before anything changes: an effect that waits for the acknowledgement, or settings that cannot be saved', (t) => {
  const failing = { on: false };
  holdSettings(t, () => { if (failing.on) throw new Error('disk full'); });
  holdLook(t);
  library(t);
  settings._values = { ...settings._values, safety: { ...settings._values.safety, photosensitivityAcknowledged: false } };
  applyPatch({ pattern: 'chase', colorA: 1, paletteOverride: ['#00FF00'] });
  applyOverride(0, null);
  const base = captureLook();
  const changed = {
    ...base, colorA: 4, paletteOverride: ['#FF0000'], audioMode: base.audioMode === 'off' ? 'reactive' : 'off',
    overrides: base.overrides.map((o, i) => (i === 0 ? { enabled: true, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false } : o)),
  };
  const unchanged = () => {
    assert.strictEqual(state.pattern, 'chase');
    assert.strictEqual(state.colorA, 1);
    assert.deepStrictEqual(getLiveState().paletteOverride, ['#00FF00']);
    assert.strictEqual(settings.get('audio.mode'), base.audioMode);
    assert.strictEqual(state.fixtures[0].override, null);
  };

  assert.throws(() => recallLook({ ...changed, pattern: 'ldj.visualizer.flash' }), (err) => err.status === 409);
  unchanged();
  // An energy strobe is such an effect too.
  for (const energyOverride of ['white-strobe', 'color-strobe']) {
    assert.throws(() => recallLook({ ...changed, energyOverride }), (err) => err.status === 409, energyOverride);
    unchanged();
    assert.strictEqual(state.energyOverride, null);
  }

  failing.on = true;
  t.mock.method(console, 'warn', () => {});
  assert.throws(() => recallLook(changed), (err) => err.status === 500 && /disk full/.test(err.message));
  unchanged();

  failing.on = false;
  recallLook(changed);
  assert.strictEqual(state.colorA, 4);
  assert.strictEqual(settings.get('audio.mode'), changed.audioMode);
  assert.strictEqual(state.fixtures[0].override.r, 255);
  applyOverride(0, null);
});
