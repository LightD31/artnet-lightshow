// Pads (src/server/pads.ts): two banks of eight, each a preset, a pattern,
// the strobe or a sequence pattern, launched held, once or as a loop, on a
// grid of its own and on the rig or some fixtures. The layout in
// config/pads.json, the routes, and the socket's voice hold with a pad.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { Pads, PadStore, PAD_COUNT, REST_TOKEN, patternPlayer } from '../../src/server/pads.ts';
import { SequenceStore } from '../../src/server/sequence-store.ts';
import { VoiceManager, HOLD_TIMEOUT_MS, builtinPresets, launchOf } from '../../src/server/voices.ts';
import { presetById } from '../../src/shared/effects/index.ts';
import { requiresAcknowledgement } from '../../src/shared/effects/registry.ts';
import { scopedLoopLength } from '../../src/shared/effects/hd.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { setupIntegrations } from '../../src/server/integrations.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { createApplier } from '../../src/server/apply.ts';
import { EffectLibrary } from '../../src/server/effect-library.ts';
import { PaletteStore } from '../../src/server/palette-store.ts';
import { stopEngine, renderFrame, renderInput } from '../../src/server/engine.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile } from '../../src/server/profiles.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { state, voices } from '../../src/server/state.ts';
import { captureLook } from '../../src/server/cues.ts';
import { conductor } from '../../src/server/conductor.ts';
import { domainOf } from '../../src/server/protocol.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import { showStore } from '../../src/server/show-store.ts';

showStore.scheduleSave = () => {};   // never the real show file

test.after(() => stopEngine());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Poll until `found()` answers, or fail saying what never came. */
async function until(found, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = found();
    if (hit) return hit;
    if (Date.now() > deadline) assert.fail(`no ${what}`);
    await wait(10);
  }
}

const preset = (id) => ({ kind: 'preset', id });
/** A pad as PUT takes it: held, on a quarter-beat grid, on the whole rig, unless `extra` says otherwise. */
const pad = (content, extra = {}) => ({ label: 'Pad', accent: '#A855F7', content, launch: 'hold', quantise: 0.25, targets: 'shared', ...extra });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} ≠ ${b}`);
const refusedWith = (status, pattern) => (err) => err.status === status && pattern.test(err.message);
/** The layout a store starts with: one that has read no file. */
const defaults = () => new PadStore(path.join(os.tmpdir(), 'pads-none', 'pads.json')).layout();

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'pads.json') };
}

/**
 * Pads over a manager on a clock of the test's own (`now` in ms, the beat
 * moving at `bpm` with it, setTimeout mocked to match), a layout in a
 * throwaway file, a rig of fixtures 0..3 and a shelf of patterns (`c.patterns`).
 */
function rig(t, { now = 1000, beat = 0, bpm = 120, running = false, acknowledged = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now, beat, bpm, running, acknowledged, fixtures: [0, 1, 2, 3], patterns: {} };
  const manager = new VoiceManager({
    now: () => c.now, beatPos: () => c.beat, bpm: () => c.bpm,
    acknowledged: () => c.acknowledged, anyRunning: () => c.running, onChange: () => {},
  });
  const { file, dir } = place(t);
  const store = new PadStore(file).load();
  const patternVoice = patternPlayer({
    voices: manager, pattern: (id) => c.patterns[id] ?? null, fixtureIds: () => c.fixtures, resolve: (id) => presetById(id)?.spec ?? null,
  });
  const pads = new Pads({ voices: manager, store, lookup: () => builtinPresets, fixtureIds: () => c.fixtures, beat: () => c.beat, patternVoice });
  const advance = (ms) => {
    c.now += ms;
    c.beat += (ms / 60000) * c.bpm;
    t.mock.timers.tick(ms);
  };
  const put = (bank, slot, entry) => store.set(bank, slot, entry);
  return { c, voices: manager, store, pads, advance, put, file, dir };
}

// ── The layout ──────────────────────────────────────────────────────────────

test('the default layout has 16 entries', (t) => {
  const { store, file } = rig(t);
  const layout = store.layout();
  assert.equal(PAD_COUNT, 16);
  assert.equal(layout.length, 16);
  assert.deepEqual(layout.map((p) => [p.bank, p.slot]), Array.from({ length: 16 }, (_, i) => [Math.floor(i / 8), i % 8]));
  // Bank 0: the six energy effects under their canonical ids, the strobe, one Hue Dynamics preset.
  assert.deepEqual(layout.slice(0, 6).map((p) => p.content),
    ['energy.whiteStrobe', 'energy.colorStrobe', 'energy.blinder', 'energy.uvWash', 'energy.kill', 'energy.glow'].map(preset));
  assert.deepEqual([layout[6].content, layout[6].launch], [{ kind: 'strobe', id: 'strobe' }, 'hold']);
  // Then nine Hue Dynamics and Light DJ presets, both apps among them.
  const nine = layout.slice(7).map((p) => presetById(p.content.id));
  assert.ok(nine.every((row) => row && !row.legacy && (row.app === 'hd' || row.app === 'ldj')));
  assert.equal(nine[0].app, 'hd');
  assert.ok(nine.some((row) => row.app === 'ldj'));
  for (const p of layout) {
    assert.match(p.accent, /^#[0-9A-F]{6}$/);
    assert.equal(p.targets, 'shared', 'on the whole rig');
    if (p.content.kind === 'preset') assert.equal(p.label, presetById(p.content.id).name);
  }
  // The energy pads and the strobe start on the press, as the energy effects
  // always have; the looks on Hue Dynamics' quarter beat.
  assert.deepEqual(layout.map((p) => p.quantise), [0, 0, 0, 0, 0, 0, 0, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
  // A fresh install plays every pad but the two energy strobes before the
  // photosensitivity acknowledgement (the strobe pad is the strobe's own).
  const waiting = layout.filter((p) => p.content.kind === 'preset' && requiresAcknowledgement(builtinPresets(p.content.id).spec));
  assert.deepEqual(waiting.map((p) => p.content.id), ['energy.whiteStrobe', 'energy.colorStrobe']);

  // Nothing is written until something changes; a copy handed out is the caller's own.
  assert.equal(fs.existsSync(file), false);
  layout[0].label = 'Mine';
  layout[0].targets = [1];
  assert.equal(store.get(0, 0).label, 'White Strobe');
  assert.equal(store.get(0, 0).targets, 'shared');
  store.set(1, 7, pad(null, { label: '' }));
  assert.equal(store.get(1, 7).content, null);
  store.reset();
  assert.deepEqual(store.layout(), defaults(), 'reset is the defaults again');
  assert.deepEqual(onDisk(file), { pads: store.layout() });
});

test('pads.json: a restart reads the layout back; a file that does not validate is moved aside whole', (t) => {
  const { store, file, dir } = rig(t);
  store.set(1, 2, pad(preset('ldj.Swirl'), { launch: 'loop', targets: [] }));
  const saved = store.layout();
  assert.deepEqual(new PadStore(file).load().layout(), saved);
  const warn = t.mock.method(console, 'warn', () => {});
  // Fifteen pads, or one twice: not a layout. The whole file goes aside, the defaults stand.
  const write = (pads) => fs.writeFileSync(file, JSON.stringify({ pads }));
  for (const bad of [saved.slice(1), [...saved.slice(0, 15), saved[0]], saved.map((p, i) => (i === 3 ? { ...p, quantise: -1 } : p))]) {
    write(bad);
    const loaded = new PadStore(file).load();
    assert.deepEqual(loaded.layout(), defaults());
    assert.equal(fs.existsSync(file), false);
  }
  // Three moved aside (within a millisecond, they share a name: counted by what was said).
  assert.equal(warn.mock.calls.filter((call) => /moved it to .*\.invalid-/.test(call.arguments[0])).length, 3);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('pads.json.invalid-')));
  // A preset nothing knows any more is the pad's still: refused at launch, not at load.
  write(saved.map((p, i) => (i === 9 ? { ...p, content: preset('user.0123456789abcdef') } : p)));
  const kept = new PadStore(file).load();
  assert.deepEqual(kept.get(1, 1).content, preset('user.0123456789abcdef'));
});

test('pads.json from a build that put the energy pads on the quarter beat: the ones still as shipped start on the press; a pad the user changed keeps its grid', (t) => {
  const { file } = rig(t);
  // What that build wrote: every default pad on 0.25, the Blinder relabelled, the Kill on a beat, a look moved to 0.5.
  const before = defaults().map((p) => ({ ...p, quantise: 0.25 }));
  before[2] = { ...before[2], label: 'Flash' };
  before[4] = { ...before[4], quantise: 1 };
  before[9] = { ...before[9], quantise: 0.5 };
  fs.writeFileSync(file, JSON.stringify({ pads: before }));
  const loaded = new PadStore(file).load().layout();
  assert.deepEqual(loaded.map((p) => p.quantise), [0, 0, 0.25, 0, 1, 0, 0, 0.25, 0.25, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(loaded[2], before[2], 'the relabelled Blinder is the user\'s, its grid with it');
  assert.deepEqual(loaded[0], defaults()[0], 'the White Strobe as shipped is today\'s');
  // Read, not written: the file is as that build left it until something changes.
  assert.deepEqual(onDisk(file), { pads: before });
});

// ── Launching ───────────────────────────────────────────────────────────────

test('press on a hold pad starts a hold voice with the pad\'s quantise and targets; release ends it', (t) => {
  const { c, voices: m, pads, put, advance } = rig(t, { beat: 10.1, running: true });
  put(0, 2, pad(preset('ldj.FadeCycle'), { label: 'Fade', targets: [2, 1, 2] }));
  const v = pads.press(0, 2, 'tablet', 't1');
  assert.deepEqual([v.mode, v.source, v.tier, v.label, v.owner, v.key], ['hold', 'pad', 'voice', 'Fade', 'tablet', 'pad:0:2']);
  assert.deepEqual(v.targets, [2, 1], 'its fixtures, once each');
  // 10.1 snaps up to 10.25: 0.15 beats at 120 BPM is 75 ms.
  near(v.startedAtMs, 1075, 'the grid line');
  assert.equal(v.anchorBeat, 10.25);
  assert.equal(pads.lit()[2], v.id);
  assert.deepEqual(m.frames(c.now), [], 'waiting for its grid line');
  advance(76);
  assert.deepEqual(m.frames(c.now).map((f) => f.id), [v.id], 'and playing once past it');

  // Pressed again with its lease running: renewed, the same launch.
  advance(500);
  const again = pads.press(0, 2, 'tablet', 't1');
  assert.deepEqual([again.id, again.launchSeq, again.startedAtMs], [v.id, v.launchSeq, v.startedAtMs]);
  // Another owner's, another token's or another pad's release is not this hold's.
  pads.release(0, 2, 'phone', 't1');
  pads.release(0, 2, 'tablet', 'other');
  pads.release(0, 3, 'tablet', 't1');
  assert.ok(m.get(v.id));
  pads.release(0, 2, 'tablet', 't1');
  assert.equal(m.get(v.id), null);
  assert.equal(pads.lit()[2], null);

  // A fixture removed since the pad was set is left out, never another's.
  c.fixtures = [0, 2, 3];
  assert.deepEqual(pads.press(0, 2, 'tablet', 'gone').targets, [2]);
  pads.release(0, 2, 'tablet', 'gone');
  c.fixtures = [0, 1, 2, 3];

  // A grid of 0 is now, whatever plays.
  put(0, 5, pad(preset('energy.blinder'), { quantise: 0 }));
  assert.equal(pads.press(0, 5, 'tablet', 'b').startedAtMs, c.now);

  // A release lets go of a hold only: a once and a loop play on.
  put(0, 3, pad(preset('ldj.FadeCycle'), { launch: 'once' }));
  put(0, 4, pad(preset('ldj.Swirl'), { launch: 'loop' }));
  const played = pads.press(0, 3, 'tablet', 't2');
  const looped = pads.press(0, 4, 'tablet', 't3');
  pads.release(0, 3, 'tablet', 't2');
  pads.release(0, 4, 'tablet', 't3');
  assert.ok(m.get(played.id) && m.get(looped.id));
  assert.equal(played.owner, null, 'a once is no lease: its page going does not end it');

  // A pad edited while held: the release still ends what the press launched.
  const held = pads.press(0, 2, 'tablet', 't4');
  put(0, 2, pad(preset('hd.auroraDrift'), { launch: 'once' }));
  pads.release(0, 2, 'tablet', 't4');
  assert.equal(m.get(held.id), null);

  // Left unrenewed, a hold dies with its lease, and the pad goes dark.
  put(0, 2, pad(preset('ldj.FadeCycle'), { quantise: 0 }));
  const dropped = pads.press(0, 2, 'tablet', 't5');
  advance(HOLD_TIMEOUT_MS);
  assert.equal(m.get(dropped.id), null);
  assert.equal(pads.lit()[2], null);
});

test('the default energy pads start on the press while the patterns run; a look waits for its quarter beat', (t) => {
  // A press 5 ms after beat 32 at 120 BPM: a quarter-beat grid would start it 120 ms later.
  const { c, pads } = rig(t, { beat: 32.01, running: true, acknowledged: true });
  for (const slot of [0, 1, 2, 3, 4, 5]) {
    const v = pads.press(0, slot, 'tablet', `e${slot}`);
    assert.deepEqual([v.startedAtMs, v.anchorBeat], [c.now, 32.01], pads.entry(0, slot).label);
  }
  const look = pads.press(0, 7, 'tablet', 'look');
  near(look.startedAtMs, c.now + 120, 'Bass Bloom on the grid line');
  assert.equal(look.anchorBeat, 32.25);
});

test('once ends after the preset\'s scoped loop length', async (t) => {
  const { voices: m, pads, put, advance } = rig(t, { bpm: 120 });
  put(1, 0, pad(preset('hd.auroraDrift'), { launch: 'once' }));
  const { spec } = builtinPresets('hd.auroraDrift');
  assert.equal(scopedLoopLength(spec, spec.params), 5, 'Aurora Drift loops at five beats');
  const v = pads.press(1, 0, 'tablet', 't');
  assert.equal(v.mode, 'once');
  assert.equal(v.untilMs - v.startedAtMs, 2500, 'five beats at 120 BPM');
  advance(2499);
  assert.equal(pads.lit()[8], v.id);
  advance(1);
  assert.equal(m.get(v.id), null);
  assert.equal(pads.lit()[8], null);

  // Its own length given: that many milliseconds. Launched again: the pad plays one voice.
  const short = pads.once(1, 0, 300);
  assert.equal(short.untilMs - short.startedAtMs, 300);
  const after = pads.once(1, 0);
  assert.equal(m.get(short.id), null);
  assert.equal(after.untilMs - after.startedAtMs, 2500);
  assert.throws(() => pads.once(1, 0, -5), refusedWith(400, /lengthMs/));
  // A Light DJ row plays its 32 beats, a hold pad played once included; a Studio row's kind would say a bar.
  put(1, 1, pad(preset('ldj.StudioN1')));
  const studio = pads.once(1, 1);
  assert.deepEqual([studio.mode, studio.untilMs - studio.startedAtMs], ['once', 16000]);

  // Over REST: `?ms=` gives its length, or the preset's when left out.
  t.mock.timers.reset();
  const s = await serve(t);
  await s.call('PUT', '/api/pads/1/0', pad(preset('hd.auroraDrift'), { launch: 'once', quantise: 0 }));
  let res = await s.call('POST', '/api/pads/1/0/once?ms=150');
  let launched = voices.get(res.body.id);
  near(launched.untilMs - launched.startedAtMs, 150, 'its own length');
  res = await s.call('POST', '/api/pads/1/0/once');
  launched = voices.get(res.body.id);
  assert.ok(Math.abs(launched.untilMs - launched.startedAtMs - 5 * 60000 / conductor.status().bpm) < 1);
  for (const ms of ['-1', '0', 'soon', '']) {
    res = await s.call('POST', `/api/pads/1/0/once?ms=${ms}`);
    assert.equal(res.status, 400, ms);
    assert.match(res.body.error, /ms/);
  }
});

test('toggle on a loop pad starts, toggle again stops', (t) => {
  const { c, voices: m, pads, put, advance } = rig(t);
  put(1, 2, pad(preset('ldj.Swirl'), { launch: 'loop' }));
  const v = pads.toggle(1, 2);
  assert.deepEqual([v.mode, v.untilMs, v.source, v.key], ['latched', null, 'pad', 'pad:1:2']);
  advance(10 * 60_000);
  assert.ok(m.get(v.id), 'a loop plays until it is stopped, as Hue Dynamics\' loops do');
  assert.equal(pads.toggle(1, 2), null);
  assert.equal(m.get(v.id), null);
  assert.equal(pads.lit()[10], null);

  // Pressing a loop pad toggles it too, whoever presses it.
  const pressed = pads.press(1, 2, 'tablet', 'a');
  assert.equal(pressed.owner, null);
  assert.equal(pads.press(1, 2, 'phone', 'b'), null);
  assert.equal(m.size, 0);

  // A loop stopped from elsewhere leaves nothing behind: the next toggle starts it.
  const w = pads.toggle(1, 2);
  m.stop(w.id);
  const x = pads.toggle(1, 2);
  assert.ok(x && x.id !== w.id);
  m.stopAll();
  assert.ok(pads.toggle(1, 2), 'a stop of everything too');
  pads.toggle(1, 2);

  // Toggle on a hold pad latches it. Stopping needs no acknowledgement; starting one that waits for it does.
  put(1, 3, pad(preset('energy.whiteStrobe')));
  c.acknowledged = true;
  const strobe = pads.toggle(1, 3);
  assert.equal(strobe.mode, 'latched');
  c.acknowledged = false;
  assert.equal(pads.toggle(1, 3), null);
  assert.equal(m.get(strobe.id), null);
  assert.throws(() => pads.toggle(1, 3), refusedWith(409, /acknowledgement/));
  assert.equal(pads.lit()[11], null);

  // Pads.stopAll stops the pads' voices, and nothing else.
  pads.toggle(1, 2);
  pads.press(0, 2, 'tablet', 'h');
  const other = m.start({ spec: { kind: 'energy.glow' }, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api' });
  assert.equal(pads.stopAll(), 2);
  assert.deepEqual(m.list().map((s) => s.id), [other.id]);
  assert.deepEqual(pads.lit(), Array(16).fill(null));
});

// ── Content a later task plays ──────────────────────────────────────────────

test('a sequencePattern pad is 409 while no `insertPattern` hook is installed', (t) => {
  const { c, voices: m, pads, put } = rig(t, { beat: 10.1, running: true });
  put(1, 4, pad({ kind: 'sequencePattern', id: 'drop' }, { quantise: 1 }));
  assert.throws(() => pads.press(1, 4, 'tablet', 't'), refusedWith(409, /pattern/));
  assert.throws(() => pads.once(1, 4), refusedWith(409, /pattern/));
  assert.throws(() => pads.toggle(1, 4), refusedWith(409, /pattern/));
  assert.equal(m.size, 0);
  // Installed (the sequencer's), a press inserts at the pad's next grid line and launches no voice.
  const inserted = [];
  pads.insertPattern = (id, atBeat) => inserted.push([id, atBeat]);
  assert.equal(pads.press(1, 4, 'tablet', 't'), null);
  c.beat = 12;
  pads.once(1, 4);
  assert.deepEqual(inserted, [['drop', 11], ['drop', 12]]);
  assert.equal(m.size, 0);
});

test('a pattern pad plays as one voice with the pad\'s launch; no Pads is built without a pattern player', (t) => {
  const { c, voices: m, pads, put, store } = rig(t);
  put(1, 5, pad({ kind: 'pattern', id: 'groove' }, { launch: 'once', quantise: 0.5, targets: [1] }));
  assert.throws(() => new Pads({ voices: m, store, lookup: () => builtinPresets, fixtureIds: () => c.fixtures }), /pattern player/);
  // A pattern not on the shelf is 404, and nothing plays.
  assert.throws(() => pads.press(1, 5, 'tablet', 't'), refusedWith(404, /groove/));
  assert.throws(() => pads.toggle(1, 5), refusedWith(404, /groove/));
  assert.equal(m.size, 0);
  // The sequencer's hook: the pad's targets, mode, grid and key, and no length, so the pattern's own plays.
  const asked = [];
  pads.patternVoice = (id, launch) => {
    asked.push([id, launch]);
    return m.start({ spec: { kind: 'ldj.FadeCycle' }, tier: 'voice', ...launch });
  };
  const v = pads.press(1, 5, 'tablet', 't');
  assert.deepEqual(asked, [['groove', { targets: [1], mode: 'once', quantise: 0.5, key: 'pad:1:5', source: 'pad', label: 'Pad' }]]);
  assert.equal(pads.lit()[13], v.id);
  pads.once(1, 5, 200);
  assert.equal(asked[1][1].lengthMs, 200);
  put(1, 5, pad({ kind: 'pattern', id: 'groove' }));
  pads.press(1, 5, 'tablet', 'h');
  assert.deepEqual([asked[2][1].mode, asked[2][1].owner, asked[2][1].token], ['hold', 'tablet', 'h']);
  pads.release(1, 5, 'tablet', 'h');
  assert.equal(pads.lit()[13], null, 'its release is the hold\'s, as any pad\'s');
});

const GLOW = { kind: 'energy.glow', params: {} };
/** Six beats: a shared lane over the pad's fixtures and track slot 1 on the second of them. */
const GROOVE = {
  id: 'groove', name: 'Groove', lengthBeats: 6,
  lanes: [
    { kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 4, presetId: 'ldj.FadeCycle', targets: 'lane', mute: false }] },
    { kind: 'track', slot: 1, clips: [{ startBeat: 2, lengthBeats: 4, effect: GLOW, targets: 'lane', mute: false }] },
  ],
};

test('the pattern player: one bundle voice over the pad\'s fixtures, a once lasting the bundle\'s length unless given one', (t) => {
  const { c, voices: m, pads, put, advance } = rig(t, { bpm: 120 });
  c.patterns.groove = GROOVE;
  put(1, 5, pad({ kind: 'pattern', id: 'groove' }, { launch: 'once', quantise: 0, targets: [1, 2] }));
  const v = pads.press(1, 5, 'tablet', 't');
  assert.deepEqual([v.spec.kind, v.spec.params.patternId, v.spec.params.once], ['pattern.bundle', 'groove', true]);
  assert.deepEqual(v.spec.params.table.clips.map((x) => [x.laneId, x.fixtureIds]), [['shared:0', [1, 2]], ['track:1', [2]]]);
  assert.deepEqual(v.targets, [1, 2]);
  assert.equal(v.untilMs - v.startedAtMs, 3000, 'six beats at 120 BPM');
  advance(2999);
  assert.equal(pads.lit()[13], v.id);
  advance(1);
  assert.equal(m.get(v.id), null);
  assert.equal(pads.lit()[13], null);
  const short = pads.once(1, 5, 300);
  assert.equal(short.untilMs - short.startedAtMs, 300, 'a length given wins');

  // Held, it plays its bundle round until released.
  put(1, 5, pad({ kind: 'pattern', id: 'groove' }, { quantise: 0 }));
  const held = pads.press(1, 5, 'tablet', 'h');
  assert.deepEqual([held.mode, held.untilMs, held.spec.params.once], ['hold', null, false]);
  pads.release(1, 5, 'tablet', 'h');
  assert.equal(pads.lit()[13], null);
  // A loop pad toggles it on and off.
  put(1, 5, pad({ kind: 'pattern', id: 'groove' }, { launch: 'loop', quantise: 0 }));
  const looped = pads.toggle(1, 5);
  assert.deepEqual([looped.mode, looped.spec.params.once], ['latched', false]);
  pads.toggle(1, 5);
  assert.equal(m.get(looped.id), null);

  // A rapid clip makes the voice wait for the acknowledgement (409), then it plays.
  c.patterns.rapid = { ...GROOVE, id: 'rapid', lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 4, effect: { kind: 'energy.whiteStrobe', params: {} }, targets: 'lane', mute: false }] }] };
  put(1, 6, pad({ kind: 'pattern', id: 'rapid' }, { quantise: 0 }));
  assert.throws(() => pads.press(1, 6, 'tablet', 'r'), refusedWith(409, /acknowledgement/));
  assert.equal(pads.lit()[14], null);
  c.acknowledged = true;
  assert.equal(pads.press(1, 6, 'tablet', 'r').spec.kind, 'pattern.bundle');
  // A strobe clip is refused as the sequence refuses it.
  c.patterns.strobe = { ...GROOVE, id: 'strobe', lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 4, effect: { kind: 'strobe', params: {} }, targets: 'lane', mute: false }] }] };
  put(1, 7, pad({ kind: 'pattern', id: 'strobe' }, { quantise: 0 }));
  assert.throws(() => pads.press(1, 7, 'tablet', 's'), refusedWith(409, /strobe/));
});

test('a strobe pad takes the strobe hook when installed and otherwise the voice-hold preset path', async (t) => {
  const { voices: m, pads, store } = rig(t, { acknowledged: true });
  assert.deepEqual(store.get(0, 6).content, { kind: 'strobe', id: 'strobe' });
  // What voice-hold made of `{ preset: 'strobe' }` before the strobe: `strobe` is the upstream pattern's id, no preset.
  let stub;
  try { launchOf({ preset: 'strobe' }, builtinPresets); } catch (err) { stub = err; }
  assert.deepEqual([stub.status, stub.message], [400, 'No such preset: strobe']);
  const same = (err) => err.status === stub.status && err.message === stub.message;
  assert.throws(() => pads.press(0, 6, 'tablet', 't'), same);
  assert.throws(() => pads.holdStrobe('tablet', 't'), same);
  assert.equal(m.size, 0);
  // It plays while held: once and toggle are no strobe pad's, hook or none.
  assert.throws(() => pads.once(0, 6), refusedWith(409, /held/));
  assert.throws(() => pads.toggle(0, 6), refusedWith(409, /held/));

  // Installed (the strobe's), the hook holds and releases with the pad's owner and token.
  const calls = [];
  pads.strobe = {
    hold(owner, token) {
      calls.push(['hold', owner, token]);
      return m.start({ spec: { kind: 'strobe' }, targets: 'shared', mode: 'hold', tier: 'strobe', source: 'strobe', owner, token });
    },
    release(owner, token) {
      calls.push(['release', owner, token]);
      m.release(owner, token);
    },
  };
  const v = pads.press(0, 6, 'tablet', 't');
  assert.equal(v.tier, 'strobe');
  assert.equal(pads.lit()[6], v.id);
  pads.release(0, 6, 'phone', 't');
  pads.release(0, 6, 'tablet', 't');
  assert.deepEqual(calls, [['hold', 'tablet', 't'], ['release', 'tablet', 't']]);
  assert.equal(m.size, 0);
  assert.equal(pads.lit()[6], null);
  // The voice-hold form takes the same hook, and so does its release with no pad named.
  pads.holdStrobe('tablet', 'u');
  pads.releaseHold('tablet', 'u');
  assert.deepEqual(calls.slice(2), [['hold', 'tablet', 'u'], ['release', 'tablet', 'u']]);
  assert.throws(() => pads.once(0, 6), refusedWith(409, /held/));

  // Over the socket: the pad and `{ preset: 'strobe' }` alike. The server
  // installs the strobe's own hook, which waits for the acknowledgement.
  t.mock.timers.reset();
  const s = await serve(t);
  const { socket, heard } = await s.page();
  socket.emit('voice-hold', { action: 'press', token: 's1', effect: { preset: 'strobe' } });
  socket.emit('voice-hold', { action: 'press', token: 's2', pad: { bank: 0, slot: 6 } });
  await until(() => heard.errors.length === 2, 'both refused');
  assert.deepEqual(heard.errors.map((e) => e.message), ['photosensitivity acknowledgement required', 'photosensitivity acknowledgement required']);
  const live = [];
  s.integrations.pads.strobe = {
    hold(owner, token) {
      live.push(['hold', owner, token]);
      return voices.start({ spec: { kind: 'energy.glow' }, targets: 'shared', mode: 'hold', tier: 'strobe', source: 'strobe', owner, token });
    },
    release(owner, token) {
      live.push(['release', owner, token]);
      voices.release(owner, token);
    },
  };
  socket.emit('voice-hold', { action: 'press', token: 's1', effect: { preset: 'strobe' } });
  socket.emit('voice-hold', { action: 'release', token: 's1' });
  socket.emit('voice-hold', { action: 'press', token: 's2', pad: { bank: 0, slot: 6 } });
  socket.emit('voice-hold', { action: 'release', token: 's2', pad: { bank: 0, slot: 6 } });
  await until(() => live.length === 4, 'the hook, both ways, both forms');
  assert.deepEqual(live, [['hold', socket.id, 's1'], ['release', socket.id, 's1'], ['hold', socket.id, 's2'], ['release', socket.id, 's2']]);
  assert.deepEqual(voices.list(), []);
});

// ── From outside ────────────────────────────────────────────────────────────

/**
 * The routes and the sockets on stand-in sources, a layout and a library of
 * their own in a throwaway directory, the real applier, and settings in
 * memory, unacknowledged: nothing written to the operator's config/.
 */
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pads-routes-'));
  const padFile = path.join(dir, 'pads.json');
  const effectLibrary = new EffectLibrary(path.join(dir, 'effects.json')).load();
  const paletteStore = new PaletteStore(path.join(dir, 'palettes.json')).load();
  const padStore = new PadStore(padFile).load();
  const sequenceStore = new SequenceStore(path.join(dir, 'sequences.json')).load();
  const idle = { onPlaybackUpdate() {}, onTrackChange() {}, getStatus: () => ({}), authenticated: false };
  const autoShow = {
    running: false, track: null, syncOffsetMs: 0, autoSyncMs: 0, analysis: null,
    getPositionMs: () => 0, getClientState: () => ({}), start() {}, stop() {},
    isCached: () => false, gridFor: () => null, isPrefetching: () => false,
    applyQueueOrder() {}, setPaletteSize() {}, setIntensity() {}, setSyncOffsetMs() {}, adjustAutoSync() {},
  };
  const prolink = {
    connected: false, stale: false, lastError: null, getNumPeers: () => 0, getFollowed: () => null, getTrack: () => null,
    getLoadedTracks: () => [], getTempo: () => 0, getPositionMs: () => 0,
    onTempoChange() {}, onPeersChange() {}, onFollowChange() {}, onTrackChange() {}, onLoadedTracksChange() {}, onAnyTrackLoaded() {},
  };
  const midi = { enabled: false, sendFeedback() {}, listPorts: () => [], onLearn() {}, close() {}, connect() { return true; }, setControlFeedback() {} };
  const values = settings._values;
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  settings._values = { ...values, safety: { ...values.safety, photosensitivityAcknowledged: false }, outputs: { ...values.outputs, armed: false } };
  settings.save = () => {};
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const io = new Server(server);
  const integrations = setupIntegrations({
    io, midi,
    spotify: { ...idle, startPolling() {}, async getQueue() { return []; } },
    nowPlaying: idle,
    deezerSource: { ...idle, getQueue: () => [], updatePlayback() {}, updateQueue() {}, disconnect() {} },
    prolink, autoShow, effectLibrary, paletteStore, padStore, sequenceStore,
  });
  const applier = createApplier({
    midi, spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} }, smtc: { start() {}, stop() {} },
    deezer: { init: async () => {} }, applyPatch, broadcast: () => integrations.broadcast(),
  });
  attachRoutes(app, { integrations, applier });
  attachSockets(io, { midi, integrations });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const look = { pattern: state.pattern, running: state.running };
  t.after(async () => {
    voices.stopAll();
    applyPatch({ ...look, energyOverride: null, masterBlackout: false });
    output.setArmed(false);
    settings._values = values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    io.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A 204 has no body: null.
  const call = (method, route, body) => fetch(`${url}${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  });
  /** A page on protocol 2, with what it hears. */
  const page = async () => {
    const socket = connect(url, { auth: { protocol: 2 }, transports: ['websocket'], reconnection: false });
    t.after(() => socket.close());
    const heard = { patches: [], errors: [] };
    socket.on('patch', (p) => heard.patches.push(p));
    socket.on('error-msg', (e) => heard.errors.push(e));
    heard.snapshot = await new Promise((resolve) => socket.once('snapshot', resolve));
    return { socket, heard };
  };
  return { call, page, integrations, padFile };
}

const FADE = preset('ldj.FadeCycle');
const ids = () => voices.list().map((v) => v.id);
/** The last `pads` the page was told, or undefined. */
const toldPads = (heard) => heard.patches.filter((p) => p.d === 'pads' && p.set.pads).at(-1)?.set.pads;

/** A fixture's colour channels and dimmer on the rig (null for one it lacks). */
const lamp = (fixture) => {
  const dmx = universes.getBuffer(fixture.universe ?? state.artnet.universe);
  const { channelMap: ch } = getProfile(fixture);
  return [ch.red, ch.green, ch.blue, ch.dimmer].map((k) => (k === undefined ? null : dmx[fixture.address - 1 + k]));
};
const onlyClip = (id, play) => ({ ...GROOVE, id, lanes: [{ kind: 'shared', slot: 0, clips: [{ startBeat: 0, lengthBeats: 6, ...play, targets: 'lane', mute: false }] }] });

test('a pattern pad over REST plays its saved pattern on the pad\'s fixtures (200); release stops it; unknown 404; rapid 409 until acknowledged', async (t) => {
  const s = await serve(t);
  const [a, b] = state.fixtures;
  applyPatch({ pattern: 'solid', colorA: 0, running: true, masterDimmer: 255, masterBlackout: false, paletteOverride: null });
  renderFrame();
  const look = [lamp(a), lamp(b)];
  const saved = await s.call('POST', '/api/sequence/patterns', onlyClip('fade', { presetId: 'ldj.FadeCycle' }));
  assert.ok(saved.status < 300, JSON.stringify(saved.body));
  await s.call('PUT', '/api/pads/1/5', pad({ kind: 'pattern', id: 'fade' }, { quantise: 0, targets: [a.id] }));
  assert.equal((await s.call('POST', '/api/pads/1/5/press')).status, 200);
  const id = s.integrations.pads.lit()[13];
  assert.deepEqual(renderInput().voices.filter((v) => v.id === id).map((v) => v.spec.kind), ['pattern.bundle'], 'one bundle voice');
  renderFrame();
  assert.notDeepEqual(lamp(a), look[0], 'its fixture lights');
  assert.deepEqual(lamp(b), look[1], 'the other keeps the look');
  assert.equal((await s.call('POST', '/api/pads/1/5/release')).status, 200);
  assert.equal(s.integrations.pads.lit()[13], null);
  assert.ok(!ids().includes(id));

  // A pattern deleted from the shelf since: 404.
  await s.call('DELETE', '/api/sequence/patterns/fade');
  const gone = await s.call('POST', '/api/pads/1/5/press');
  assert.deepEqual([gone.status, gone.body.error], [404, 'No such pattern: fade']);

  // A rapid clip: 409 before the acknowledgement, 200 after.
  await s.call('POST', '/api/sequence/patterns', onlyClip('rapid', { effect: { kind: 'energy.whiteStrobe', params: {} } }));
  await s.call('PUT', '/api/pads/1/6', pad({ kind: 'pattern', id: 'rapid' }, { quantise: 0 }));
  assert.equal((await s.call('POST', '/api/pads/1/6/press')).status, 409);
  assert.equal(s.integrations.pads.lit()[14], null);
  await s.call('POST', '/api/safety/acknowledge');
  assert.equal((await s.call('POST', '/api/pads/1/6/press')).status, 200);
  assert.ok(s.integrations.pads.lit()[14]);
  await s.call('POST', '/api/pads/1/6/release');
});

test('PUT a pad entry persists and validates (unknown preset → 400)', async (t) => {
  const s = await serve(t);
  const [a, b] = state.fixtures.map((f) => f.id);
  const entry = pad(preset('hd.auroraDrift'), { label: 'Drift', accent: '#06b6d4', launch: 'loop', quantise: 0.5, targets: [b, a, b] });
  let res = await s.call('PUT', '/api/pads/1/3', entry);
  assert.equal(res.status, 200);
  const saved = { bank: 1, slot: 3, ...entry, accent: '#06B6D4', targets: [b, a] };
  assert.deepEqual(res.body.pad, saved);
  assert.deepEqual(onDisk(s.padFile).pads[11], saved);
  assert.deepEqual(new PadStore(s.padFile).load().get(1, 3), saved, 'a restart reads it back');
  assert.deepEqual((await s.call('GET', '/api/pads')).body.layout[11], saved);
  // An alias names its preset; the bank and slot may come along when they are the URL's.
  res = await s.call('PUT', '/api/pads/1/3', { ...entry, bank: 1, slot: 3, content: preset('blinder') });
  assert.equal(res.status, 200);

  const refused = async (route, body, pattern) => {
    const r = await s.call('PUT', route, body);
    assert.equal(r.status, 400, `${route} ${JSON.stringify(body)}`);
    assert.match(r.body.error, pattern);
  };
  await refused('/api/pads/1/3', { ...entry, content: preset('no.such') }, /content\.id No such preset: no\.such/);
  await refused('/api/pads/1/3', { ...entry, content: preset('strobe') }, /content\.id No such preset: strobe/);
  await refused('/api/pads/1/3', { ...entry, quantise: -0.25 }, /quantise/);
  await refused('/api/pads/1/3', { ...entry, targets: [999] }, /targets no fixture 999/);
  await refused('/api/pads/1/3', { ...entry, targets: 'all' }, /targets/);
  await refused('/api/pads/1/3', { ...entry, accent: 'pink' }, /accent/);
  await refused('/api/pads/1/3', { ...entry, launch: 'latched' }, /launch/);
  await refused('/api/pads/1/3', { ...entry, content: { kind: 'strobe', id: 'strobe' } }, /launch/);
  await refused('/api/pads/1/3', { ...entry, content: { kind: 'clip', id: 'x' } }, /content\.kind/);
  await refused('/api/pads/1/3', { ...entry, label: undefined }, /label/);
  await refused('/api/pads/1/3', { ...entry, colour: '#FFFFFF' }, /colour/);
  await refused('/api/pads/1/3', { ...entry, bank: 0 }, /bank/);
  await refused('/api/pads/2/0', entry, /bank/);
  await refused('/api/pads/0/8', entry, /slot/);
  await refused('/api/pads/0/x', entry, /slot/);
  assert.deepEqual(new PadStore(s.padFile).load().get(1, 3).content, preset('blinder'), 'none of them saved');

  // The whole layout at once: sixteen, each place once, all or nothing.
  const layout = (await s.call('GET', '/api/pads')).body.layout;
  const next = layout.map((p) => ({ ...p, quantise: 0 }));
  res = await s.call('PUT', '/api/pads', { pads: next });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.layout, next);
  await refused('/api/pads', { pads: next.map((p, i) => (i === 15 ? { ...p, content: preset('no.such') } : { ...p, quantise: 1 })) },
    /15\.content\.id No such preset/);
  await refused('/api/pads', { pads: next.slice(1) }, /pads/);
  await refused('/api/pads', { pads: [...next.slice(0, 15), next[0]] }, /twice/);
  await refused('/api/pads', next, /pads/);
  assert.deepEqual((await s.call('GET', '/api/pads')).body.layout, next, 'the layout as it was');
  assert.deepEqual(onDisk(s.padFile).pads, next);

  // A saved preset deleted since stays on its pad: refused at launch, and the layout around it still saves.
  const mine = (await s.call('POST', '/api/effects', { name: 'Mine', spec: { kind: 'ldj.FadeCycle' } })).body.preset;
  await s.call('PUT', '/api/pads/0/7', pad(preset(mine.id), { quantise: 0 }));
  await s.call('DELETE', `/api/effects/${mine.id}`);
  const kept = (await s.call('GET', '/api/pads')).body.layout;
  assert.deepEqual(kept[7].content, preset(mine.id));
  res = await s.call('POST', '/api/pads/0/7/press');
  assert.deepEqual([res.status, res.body.error], [400, `No such preset: ${mine.id}`]);
  assert.equal((await s.call('PUT', '/api/pads', { pads: kept.map((p) => ({ ...p, label: 'Kept' })) })).status, 200);
});

test('an empty pad does nothing (204)', async (t) => {
  const s = await serve(t);
  const { socket, heard } = await s.page();
  await s.call('PUT', '/api/pads/0/7', pad(null, { label: '' }));
  const before = voices.list();
  for (const action of ['press', 'release', 'toggle', 'once', 'once?ms=200']) {
    const res = await s.call('POST', `/api/pads/0/7/${action}`);
    assert.deepEqual([res.status, res.body], [204, null], action);
  }
  socket.emit('voice-hold', { action: 'press', token: 'e', pad: { bank: 0, slot: 7 } });
  socket.emit('voice-hold', { action: 'release', token: 'e', pad: { bank: 0, slot: 7 } });
  await wait(100);
  assert.deepEqual(voices.list(), before);
  assert.deepEqual(heard.errors, []);
  assert.equal(s.integrations.pads.press(0, 7, 'tablet', 't'), null);
  assert.equal(s.integrations.pads.toggle(0, 7), null);
});

test('voice-hold with pad goes through Pads.press and release through the socket', async (t) => {
  const s = await serve(t);
  const { socket, heard } = await s.page();
  assert.equal(domainOf('pads'), 'pads');
  assert.equal(heard.snapshot.versions.pads, 0);
  assert.equal(heard.snapshot.state.pads.layout.length, 16);
  const target = state.fixtures[1].id;
  // An edit is published as it is saved, not on the next once-a-second sweep.
  const published = t.mock.method(s.integrations.publisher, 'publishState');
  await s.call('PUT', '/api/pads/0/2', pad(FADE, { label: 'Fade', quantise: 0, targets: [target] }));
  assert.ok(published.mock.calls.some((call) => call.arguments[0].pads.layout[2].label === 'Fade'), 'published with the save');
  await until(() => toldPads(heard)?.layout[2].label === 'Fade', 'the page told of the edit');

  socket.emit('voice-hold', { action: 'press', token: 'p1', pad: { bank: 0, slot: 2 } });
  await until(() => ids().length === 1, 'the pad held');
  const [held] = voices.list();
  assert.deepEqual([held.source, held.mode, held.label, held.targets], ['pad', 'hold', 'Fade', [target]]);
  assert.equal(voices.get(held.id).owner, socket.id, 'the socket owns it, nothing the message says');
  await until(() => toldPads(heard)?.lit[2] === held.id, 'the page hearing the pad lit');
  for (let i = 0; i < 5; i++) {
    await wait(300);
    socket.emit('voice-hold', { action: 'renew', token: 'p1' });
  }
  assert.deepEqual(ids(), [held.id], `renewed past ${HOLD_TIMEOUT_MS} ms`);
  socket.emit('voice-hold', { action: 'release', token: 'p1', pad: { bank: 0, slot: 2 } });
  await until(() => !ids().length, 'the release');
  await until(() => toldPads(heard)?.lit[2] === null, 'the page hearing it dark');

  // A release naming no pad: the token names the hold.
  socket.emit('voice-hold', { action: 'press', token: 'p2', pad: { bank: 0, slot: 2 } });
  await until(() => ids().length === 1, 'the second hold');
  socket.emit('voice-hold', { action: 'release', token: 'p2' });
  await until(() => !ids().length, 'its release');
  // A pad that is none is told.
  socket.emit('voice-hold', { action: 'press', token: 'p3', pad: { bank: 2, slot: 0 } });
  socket.emit('voice-hold', { action: 'press', token: 'p4', pad: 3 });
  await until(() => heard.errors.length === 2, 'two refusals');
  assert.ok(heard.errors.every((e) => e.source === 'voice-hold' && /pad/.test(e.message)));
  // The page going takes its pad hold with it, before its lease could end.
  socket.emit('voice-hold', { action: 'press', token: 'p5', pad: { bank: 0, slot: 2 } });
  await until(() => ids().length === 1, 'a last hold');
  socket.close();
  await until(() => !ids().length, 'the hold gone with its page', HOLD_TIMEOUT_MS / 2);
});

test('a REST press and a socket press of the same pad do not share a lease', async (t) => {
  const s = await serve(t);
  const { socket } = await s.page();
  await s.call('PUT', '/api/pads/0/3', pad(FADE, { quantise: 0 }));
  // The socket's hold, under the very token the REST fallback uses.
  socket.emit('voice-hold', { action: 'press', token: REST_TOKEN, pad: { bank: 0, slot: 3 } });
  const [fromSocket] = await until(() => voices.list().length === 1 && voices.list(), 'the socket\'s hold');
  let res = await s.call('POST', '/api/pads/0/3/release');
  assert.deepEqual([res.status, res.body], [200, { ok: true, released: false }]);
  assert.deepEqual(ids(), [fromSocket.id], 'a bare REST release is not the socket\'s');

  // A REST press: a lease of its own, and the pad's voice (a pad plays one at a time).
  res = await s.call('POST', '/api/pads/0/3/press');
  assert.equal(res.body.token, REST_TOKEN);
  const fromRest = res.body.id;
  assert.notEqual(fromRest, fromSocket.id);
  assert.notEqual(voices.get(fromRest).owner, socket.id);
  socket.emit('voice-hold', { action: 'release', token: REST_TOKEN, pad: { bank: 0, slot: 3 } });
  socket.emit('voice-hold', { action: 'release', token: REST_TOKEN });
  await wait(100);
  assert.deepEqual(ids(), [fromRest], 'nor is the socket\'s release the REST press\'s');
  // Pressed again in time: renewed, the same launch.
  res = await s.call('POST', '/api/pads/0/3/press');
  assert.equal(res.body.id, fromRest);
  res = await s.call('POST', '/api/pads/0/3/release');
  assert.deepEqual(res.body, { ok: true, released: true });
  assert.deepEqual(ids(), []);

  // A token of the caller's own is its own lease: the bare release leaves it.
  res = await s.call('POST', '/api/pads/0/3/press', { token: 'deck-a' });
  assert.equal(res.body.token, 'deck-a');
  assert.equal((await s.call('POST', '/api/pads/0/3/release')).body.released, false);
  assert.deepEqual(ids(), [res.body.id]);
  assert.equal((await s.call('POST', '/api/pads/0/3/release?token=deck-a')).body.released, true);
  assert.deepEqual(ids(), []);
  for (const token of ['', 'x'.repeat(65), 7]) {
    const r = await s.call('POST', '/api/pads/0/3/press', { token });
    assert.equal(r.status, 400, JSON.stringify(token));
    assert.match(r.body.error, /token/);
  }

  // Each pad has a REST owner of its own: a bare press on one is no other pad's lease.
  await s.call('PUT', '/api/pads/0/4', pad(FADE, { quantise: 0 }));
  const three = (await s.call('POST', '/api/pads/0/3/press')).body.id;
  const four = (await s.call('POST', '/api/pads/0/4/press')).body.id;
  assert.deepEqual(ids().sort(), [three, four].sort());
  assert.equal((await s.call('POST', '/api/pads/0/3/release')).body.released, true);
  assert.deepEqual(ids(), [four]);
  await s.call('POST', '/api/pads/0/4/release');

  // A REST hold is renewed only by pressing again: left alone, it dies with its lease.
  res = await s.call('POST', '/api/pads/0/3/press');
  await until(() => !voices.get(res.body.id), 'the REST hold\'s lease running out', HOLD_TIMEOUT_MS + 1000);
});

test('a pad or a voice playing an energy effect is the live state\'s energyOverride, as the energy hold is; the latch and a cue stay the energy endpoints\'', async (t) => {
  const s = await serve(t);
  settings._values.safety.photosensitivityAcknowledged = true;
  const live = async () => (await s.call('GET', '/api/state')).body.energyOverride;
  const { socket } = await s.page();

  // The default Blinder (A3) held from the deck, as Perform and the command bar hold it.
  socket.emit('voice-hold', { action: 'press', token: 'b', pad: { bank: 0, slot: 2 } });
  await until(() => state.heldEnergy === 'blinder', 'the held pad');
  assert.equal(await live(), 'blinder');
  assert.equal(state.energyOverride, null, 'nothing latched');
  assert.equal(captureLook().energyOverride, null, 'a cue saves the latch alone');
  socket.emit('voice-hold', { action: 'release', token: 'b', pad: { bank: 0, slot: 2 } });
  await until(() => state.heldEnergy === null, 'let go');
  assert.equal(await live(), null);

  // The UV Wash (A4) as a loop: on until tapped again.
  await s.call('PUT', '/api/pads/0/3', { ...s.integrations.pads.entry(0, 3), launch: 'loop' });
  await s.call('POST', '/api/pads/0/3/toggle');
  assert.equal(await live(), 'uv-wash');
  // A latch launched after it plays over it, and shows; a pad launched after the latch plays over that.
  await s.call('POST', '/api/energy/kill');
  assert.deepEqual([state.heldEnergy, state.energyOverride, await live()], [null, 'kill', 'kill']);
  await s.call('POST', '/api/pads/0/3/toggle');
  await s.call('POST', '/api/pads/0/3/toggle');
  assert.deepEqual([state.heldEnergy, state.energyOverride, await live()], ['uv-wash', 'kill', 'uv-wash']);
  assert.equal(captureLook().energyOverride, 'kill');
  await s.call('POST', '/api/energy/off');
  assert.equal(await live(), 'uv-wash');
  await s.call('POST', '/api/pads/0/3/toggle');
  assert.equal(await live(), null);

  // A voice of an energy kind from the API, and a pad playing the palette strobe, show as well.
  const { id } = (await s.call('POST', '/api/voices', { preset: 'energy.kill', mode: 'latched' })).body;
  assert.equal(await live(), 'kill');
  await s.call('DELETE', `/api/voices/${id}`);
  assert.equal(await live(), null);
  await s.call('PUT', '/api/pads/1/0', pad(preset('palette-strobe'), { quantise: 0 }));
  await s.call('POST', '/api/pads/1/0/press');
  assert.equal(await live(), 'palette-strobe');
  await s.call('POST', '/api/pads/1/0/release');
  assert.equal(await live(), null);

  // The manual strobe (the strobe pad, A7) is no energy effect: the live state's strobe says it plays.
  await s.call('POST', '/api/pads/0/6/press');
  assert.equal((await s.call('GET', '/api/state')).body.strobe.mode, 'hold');
  assert.equal(await live(), null);
  await s.call('POST', '/api/pads/0/6/release');
});

test('disarm stops a pad voice and the pads key shows it unlit', async (t) => {
  const s = await serve(t);
  const { heard } = await s.page();
  await s.call('PUT', '/api/pads/1/2', pad(FADE, { launch: 'loop', quantise: 0 }));
  let res = await s.call('POST', '/api/pads/1/2/toggle');
  const { id } = res.body;
  assert.ok(id);
  assert.equal((await s.call('GET', '/api/state')).body.pads.lit[10], id);
  assert.deepEqual((await s.call('GET', '/api/pads')).body.lit[10], id);
  await until(() => toldPads(heard)?.lit[10] === id, 'the page hearing the pad lit');

  // Disarmed already, as a rehearsal is: an explicit disarm still stops it.
  assert.equal((await s.call('POST', '/api/outputs/disarm')).body.armed, false);
  assert.deepEqual(ids(), []);
  assert.equal((await s.call('GET', '/api/state')).body.pads.lit[10], null);
  await until(() => toldPads(heard)?.lit[10] === null, 'the page hearing it dark');

  // Nothing is left to restore: the next toggle starts it afresh, the one after stops it.
  res = await s.call('POST', '/api/pads/1/2/toggle');
  assert.ok(res.body.id && res.body.id !== id);
  res = await s.call('POST', '/api/pads/1/2/toggle');
  assert.deepEqual(res.body, { ok: true, id: null });
  assert.deepEqual(ids(), []);
});

test('REST renew extends a live pad hold and never launches: a loop is not toggled, a once not fired again, a hold stopped by DELETE /api/voices stays stopped', async (t) => {
  const s = await serve(t);
  await s.call('PUT', '/api/pads/0/3', pad(FADE, { quantise: 0 }));
  await s.call('PUT', '/api/pads/0/4', pad(FADE, { quantise: 0, launch: 'loop' }));
  await s.call('PUT', '/api/pads/0/5', pad(FADE, { quantise: 0, launch: 'once' }));

  // A hold: press, then renew keeps the same launch.
  const held = (await s.call('POST', '/api/pads/0/3/press', { token: 'deck-a' })).body.id;
  const res = await s.call('POST', '/api/pads/0/3/renew', { token: 'deck-a' });
  assert.deepEqual([res.status, res.body], [200, { ok: true, renewed: true }]);
  assert.deepEqual(ids(), [held]);
  // Another token's renew is not this hold's.
  assert.equal((await s.call('POST', '/api/pads/0/3/renew')).body.renewed, false);

  // Stop-all: the renewal finds nothing, and a press under the old token is refused until let go.
  await s.call('DELETE', '/api/voices');
  assert.equal((await s.call('POST', '/api/pads/0/3/renew', { token: 'deck-a' })).body.renewed, false);
  assert.equal((await s.call('POST', '/api/pads/0/3/press', { token: 'deck-a' })).status, 409);
  assert.deepEqual(ids(), []);
  await s.call('POST', '/api/pads/0/3/release', { token: 'deck-a' });
  assert.equal((await s.call('POST', '/api/pads/0/3/press', { token: 'deck-a' })).status, 200, 'let go: a fresh press');
  await s.call('POST', '/api/pads/0/3/release', { token: 'deck-a' });

  // A loop toggled on stays on through renewals; a once is not fired again.
  const loop = (await s.call('POST', '/api/pads/0/4/press', { token: 'deck-b' })).body.id;
  const once = (await s.call('POST', '/api/pads/0/5/press', { token: 'deck-c' })).body.id;
  const seqOf = (id) => voices.get(id)?.launchSeq;
  const before = [seqOf(loop), seqOf(once)];
  assert.equal((await s.call('POST', '/api/pads/0/4/renew', { token: 'deck-b' })).body.renewed, false);
  assert.equal((await s.call('POST', '/api/pads/0/5/renew', { token: 'deck-c' })).body.renewed, false);
  assert.deepEqual([seqOf(loop), seqOf(once)], before, 'nothing launched again');
  assert.ok(voices.get(loop), 'the loop still on');
  assert.equal((await s.call('POST', '/api/pads/0/9/renew')).status, 400);
});
