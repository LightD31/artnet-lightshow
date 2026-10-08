// The effect library (src/server/effect-library.ts): the built-in catalogue
// beside the presets saved on this server, in config/effects.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EffectLibrary, MAX_PRESETS } from '../../src/server/effect-library.ts';
import { CATALOGUE, presetById } from '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'effects.json') };
}

/** A clock that moves on a second at every reading. */
function ticking(from = Date.UTC(2026, 9, 5, 20, 0, 0)) {
  let ms = from;
  return () => new Date((ms += 1000) - 1000);
}

const quietly = (t) => t.mock.method(console, 'warn', () => {});
const invalidIn = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.invalid-'));
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const FADE = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };

test("built-in aliases share their immutable resolved spec", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const strobe = presetById('energy.whiteStrobe');
  assert.deepEqual(library.resolve('energy.whiteStrobe'), strobe.spec);
  assert.deepEqual(library.resolve('white-strobe'), strobe.spec, 'an alias plays its canonical row');
  assert.equal(library.resolve('white-strobe'), library.resolve('energy.whiteStrobe'));
  assert.ok(Object.isFrozen(library.resolve('white-strobe').params));
});

test("legacy patterns remain known without an effect spec", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const legacy = CATALOGUE.find((p) => p.legacy);
  assert.equal(library.resolve(legacy.id), null, 'the renderer keeps drawing a legacy row with its pattern function');
  assert.equal(library.isKnownPattern(legacy.id), true);
  assert.equal(library.resolve('solid'), null, 'a pattern with no catalogue row');
  assert.equal(library.isKnownPattern('solid'), true);
});

test("unknown effects resolve to no preset", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  assert.equal(library.resolve('no-such-thing'), null);
  assert.equal(library.isKnownPattern('no-such-thing'), false);
  assert.equal(library.get('no-such-thing'), null);
});

test("preset lookup includes built-in metadata", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const legacy = CATALOGUE.find((p) => p.legacy);
  const entry = library.get('white-strobe');
  assert.equal(entry.source, 'builtin');
  assert.equal(entry.preset.id, 'energy.whiteStrobe');
  assert.deepEqual(entry.preset.aliases, ['white-strobe']);
  const ldj = CATALOGUE.find((p) => p.app === 'ldj' && !p.legacy);
  assert.equal(library.get(ldj.id).preset.lengthBeats, 32);
  assert.deepEqual(library.get(legacy.id).preset, JSON.parse(JSON.stringify(legacy)));
});

test("returned built-in records cannot mutate the catalogue", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const strobe = presetById('energy.whiteStrobe');
  const entry = library.get('white-strobe');
  entry.preset.spec.params.flashesPerSecond = 1;
  const listed = library.list();
  listed.builtin[0].name = 'changed';
  assert.deepEqual(library.get('white-strobe').preset.spec, strobe.spec);
  assert.equal(library.list().builtin[0].name, CATALOGUE[0].name);
  assert.equal(listed.builtin.length, CATALOGUE.length);
});

test("creating presets persists normalized defaults and metadata", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  let heard = 0;
  library.onChange(() => { heard++; });
  assert.equal(library.revision(), 0);
  assert.deepEqual(library.list().user, []);
  const created = library.create({ name: 'Slow fade', spec: FADE });
  assert.match(created.id, /^user\.[0-9a-f]{16}$/);
  assert.equal(created.name, 'Slow fade');
  assert.deepEqual(created.spec, validateSpec(FADE), 'stored with the kind\'s defaults filled in');
  assert.equal(created.createdAt, '2026-10-05T20:00:00.000Z');
  assert.equal(created.updatedAt, created.createdAt);
  assert.equal(library.revision(), 1);
  assert.equal(heard, 1);
  assert.deepEqual(onDisk(file), { presets: [created] });
  assert.deepEqual(library.resolve(created.id), created.spec);
  assert.equal(library.isKnownPattern(created.id), true);
  assert.deepEqual(library.get(created.id), { source: 'user', preset: created });
  assert.deepEqual(new EffectLibrary(file).load().list().user, [created], 'a restart reads it back');
});

test("renaming presets preserves their playing spec", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  const created = library.create({ name: 'Slow fade', spec: FADE });
  const playing = library.resolve(created.id);
  const renamed = library.update(created.id, { name: 'Slower fade' });
  assert.equal(renamed.name, 'Slower fade');
  assert.equal(renamed.createdAt, created.createdAt);
  assert.equal(renamed.updatedAt, '2026-10-05T20:00:01.000Z');
  assert.equal(library.resolve(created.id), playing);
  assert.equal(library.revision(), 2);
});

test("updating preset specs publishes a new resolved revision", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  let heard = 0;
  library.onChange(() => { heard++; });
  const created = library.create({ name: 'Slow fade', spec: FADE });
  library.update(created.id, { name: 'Slower fade' });
  const respec = library.update(created.id, { spec: { kind: 'ldj.FadeCycle', params: { cadence: 4 } } });
  assert.equal(respec.spec.params.cadence, 4);
  assert.equal(library.resolve(created.id).params.cadence, 4);
  assert.equal(library.revision(), 3);
  assert.equal(heard, 3);
});

test("unchanged preset updates avoid writes and notifications", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  let heard = 0;
  library.onChange(() => { heard++; });
  const created = library.create({ name: 'Slow fade', spec: FADE });
  library.update(created.id, { name: 'Slower fade' });
  const respec = library.update(created.id, { spec: { kind: 'ldj.FadeCycle', params: { cadence: 4 } } });
  const before = fs.statSync(file).mtimeMs;
  const write = t.mock.method(library, 'write');
  const same = library.update(created.id, { name: 'Slower fade', spec: { params: { beats: 32, cadence: 4 }, brightness: 1, kind: 'ldj.FadeCycle' } });
  assert.deepEqual(same, respec);
  assert.deepEqual(library.update(created.id, {}), respec);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(library.revision(), 3);
  assert.equal(heard, 3);
  write.mock.restore();
});

test("returned user records cannot mutate the resolved preset", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  const created = library.create({ name: 'Slow fade', spec: FADE });
  const respec = library.update(created.id, { spec: { kind: 'ldj.FadeCycle', params: { cadence: 4 } } });
  respec.spec.params.cadence = 8;
  library.list().user[0].spec.params.cadence = 8;
  assert.equal(library.resolve(created.id).params.cadence, 4);
});

test("removing presets persists deletion and ignores missing records", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  let heard = 0;
  library.onChange(() => { heard++; });
  const created = library.create({ name: 'Slow fade', spec: FADE });
  library.update(created.id, { name: 'Slower fade' });
  library.update(created.id, { spec: { kind: 'ldj.FadeCycle', params: { cadence: 4 } } });
  assert.equal(library.remove(created.id), true);
  assert.equal(library.resolve(created.id), null);
  assert.equal(library.isKnownPattern(created.id), false);
  assert.equal(library.revision(), 4);
  assert.equal(heard, 4);
  assert.deepEqual(onDisk(file), { presets: [] });
  assert.equal(library.remove(created.id), false);
  assert.equal(library.update(created.id, { name: 'gone' }), null);
  assert.equal(library.revision(), 4);
});

test("invalid preset records leave the library unchanged", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const kept = library.create({ name: 'Kept', spec: FADE });
  const refused = (fn) => assert.throws(fn, (err) => err.status === 400);
  refused(() => library.create({ name: 'Nope', spec: { kind: 'no.such.kind', params: {} } }));
  refused(() => library.create({ name: 'Nope', spec: { kind: 'ldj.FadeCycle', params: { cadence: 'fast' } } }));
  refused(() => library.create({ name: 'Nope', spec: { ...FADE, palette: ['random'] } }));
  refused(() => library.create({ name: 'Nope' }));
  refused(() => library.create({ spec: FADE }));
  refused(() => library.create({ name: '', spec: FADE }));
  refused(() => library.create({ name: 'x'.repeat(81), spec: FADE }));
  refused(() => library.create({ name: 'Nope', effect: FADE }));
  refused(() => library.create({ name: 'Nope', spec: FADE, id: 'mine' }));
  refused(() => library.update(kept.id, { spec: { kind: 'no.such.kind' } }));
  refused(() => library.update(kept.id, { name: 'Nope', createdAt: 'yesterday' }));
  assert.deepEqual(library.list().user.map((p) => p.name), ['Kept']);
  assert.equal(library.revision(), 1);
});

test("preset validation reports field paths for invalid cadence", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  assert.throws(() => library.create({ name: 'Nope', spec: { kind: 'ldj.FadeCycle', params: { cadence: 'fast' } } }),
    (err) => err.issues[0].path.join('.') === 'params.cadence');
});

test("preset validation rejects invalid nested macro cadence", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const step = (effect) => ({ effect, beats: 4 });
  assert.throws(() => library.create({ name: 'Nope', spec: { kind: 'macro', params: { steps: [step(FADE), step({ kind: 'ldj.FadeCycle', params: { cadence: 'fast' } })], loopBeats: 8 } } }),
    (err) => err.issues[0].path.join('.') === 'params.steps.1.effect.params.cadence');
});

test("preset palettes preserve Random sentinel values", (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  library.create({ name: 'Kept', spec: FADE });
  const sentinel = library.create({ name: 'Random', spec: { ...FADE, palette: [{ random: true }, '#abc'] } });
  assert.deepEqual(sentinel.spec.palette, [{ random: true }, '#abc'], 'a spec\'s palette stays as the inspector sent it');
  assert.deepEqual(library.list().user.map((p) => p.name), ['Kept', 'Random']);
  assert.equal(library.revision(), 2);
});

test('built-ins cannot be updated or removed (404)', (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const legacy = CATALOGUE.find((p) => p.legacy);
  for (const id of ['energy.whiteStrobe', 'white-strobe', legacy.id, 'solid']) {
    assert.equal(library.update(id, { name: 'Mine now', spec: FADE }), null, id);
    assert.equal(library.remove(id), false, id);
  }
  assert.deepEqual(library.resolve('white-strobe'), presetById('white-strobe').spec);
  assert.equal(library.revision(), 0);
  assert.equal(fs.existsSync(file), false, 'nothing written');
});

test('the 257th preset is refused', (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  for (let i = 0; i < MAX_PRESETS; i++) library.create({ name: `Preset ${i + 1}`, spec: FADE });
  assert.equal(MAX_PRESETS, 256);
  assert.throws(() => library.create({ name: 'One too many', spec: FADE }), (err) => err.status === 400);
  assert.equal(library.list().user.length, 256);
  assert.equal(library.revision(), 256);
  assert.equal(onDisk(file).presets.length, 256);
  assert.equal(new EffectLibrary(file).load().list().user.length, 256, 'a full library loads');
});

test('a failed write changes nothing: not the library, not the file, not the revision', (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  const kept = library.create({ name: 'Kept', spec: FADE });
  let heard = 0;
  library.onChange(() => { heard++; });
  const warn = quietly(t);
  t.mock.method(library, 'write', () => { throw new Error('disk full'); });

  const failed = (fn) => assert.throws(fn, (err) => err.status === 500);
  failed(() => library.create({ name: 'Lost', spec: FADE }));
  failed(() => library.update(kept.id, { name: 'Lost', spec: { ...FADE, params: { cadence: 4 } } }));
  failed(() => library.remove(kept.id));
  assert.deepEqual(library.list().user, [kept]);
  assert.deepEqual(library.resolve(kept.id), kept.spec);
  assert.equal(library.revision(), 1);
  assert.equal(heard, 0);
  assert.deepEqual(onDisk(file), { presets: [kept] });
  assert.ok(warn.mock.callCount() >= 3, 'the fault is logged');
});

test('a listener that throws does not undo a saved change, nor stop the next listener', (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file).load();
  const warn = quietly(t);
  let heard = 0;
  library.onChange(() => { throw new Error('broadcast broke'); });
  library.onChange(() => { heard++; });
  const created = library.create({ name: 'Saved', spec: FADE });
  assert.equal(heard, 1);
  assert.equal(library.revision(), 1);
  assert.deepEqual(onDisk(file).presets, [created]);
  assert.equal(warn.mock.callCount(), 1);
});

test('preset admission runs before persistence and leaves refusals atomic', (t) => {
  const { file } = place(t);
  const library = new EffectLibrary(file, { now: ticking() }).load();
  const asked = [];
  library.setAdmission((id, spec) => {
    asked.push([id, spec.params.cadence]);
    if (spec.params.cadence < 1) throw Object.assign(new Error('photosensitivity acknowledgement required'), { status: 409 });
  });
  const preset = library.create({ name: 'Fade', spec: FADE });
  assert.deepEqual(asked, [[preset.id, 2]]);

  assert.throws(() => library.update(preset.id, { spec: { kind: 'ldj.FadeCycle', params: { cadence: 0.25 } } }), (err) => err.status === 409);
  assert.deepEqual(library.resolve(preset.id), preset.spec);
  assert.equal(library.revision(), 1);
  assert.deepEqual(onDisk(file).presets, [preset]);

  // A rename, or the same spec again, plays nothing new: no question asked.
  library.update(preset.id, { name: 'Renamed', spec: FADE });
  assert.equal(asked.length, 2);
  assert.throws(() => library.create({ name: 'Fast', spec: { kind: 'ldj.FadeCycle', params: { cadence: 0.25 } } }), (err) => err.status === 409);
  assert.equal(library.list().user.length, 1);
});

test('invalid preset files are quarantined', (t) => {
  const { dir, file } = place(t);
  const warn = quietly(t);
  const good = { id: 'user.0000000000000001', name: 'Good', spec: validateSpec(FADE), createdAt: '2026-10-05T20:00:00.000Z', updatedAt: '2026-10-05T20:00:00.000Z' };
  const cases = [
    ['an unknown kind', [good, { ...good, id: 'user.2', spec: { kind: 'no.such.kind', params: {} } }]],
    ['a spec its kind refuses', [{ ...good, spec: { kind: 'ldj.FadeCycle', params: { cadence: 'fast' } } }]],
    ['a duplicate id', [good, good]],
    ['a built-in id', [{ ...good, id: 'energy.whiteStrobe' }]],
    ['a built-in alias', [{ ...good, id: 'white-strobe' }]],
    ['a pattern id', [{ ...good, id: 'solid' }]],
    ['a route word', [{ ...good, id: 'command' }]],
    ['too many', Array.from({ length: MAX_PRESETS + 1 }, (_, i) => ({ ...good, id: `user.${i}` }))],
    ['an unknown field', [{ ...good, effect: FADE }]],
  ];
  for (const [what, presets] of cases) {
    const bytes = JSON.stringify({ presets });
    fs.writeFileSync(file, bytes);
    const library = new EffectLibrary(file).load();
    assert.deepEqual(library.list().user, [], what);
    assert.equal(library.resolve(good.id), null, what);
    assert.equal(fs.existsSync(file), false, `${what}: moved aside`);
    assert.equal(invalidIn(dir).length, 1, what);
    // Every preset in it, the good ones too, can be had back from the copy.
    assert.equal(fs.readFileSync(path.join(dir, invalidIn(dir)[0]), 'utf8'), bytes, `${what}: recoverable`);
    for (const f of invalidIn(dir)) fs.rmSync(path.join(dir, f));
  }
  assert.ok(warn.mock.callCount() >= cases.length);

  // A good file loads with its specs as stored, defaults and all.
  fs.writeFileSync(file, JSON.stringify({ presets: [good] }));
  const library = new EffectLibrary(file).load();
  assert.deepEqual(library.list().user, [good]);
  assert.deepEqual(library.resolve(good.id), good.spec);
});
