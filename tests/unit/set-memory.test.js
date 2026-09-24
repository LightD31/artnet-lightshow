// The night so far: each track avoids the last one's palette and looks, keeps
// some of its colours when the two keys mix, and paces its big moments
// against the tracks before it (src/show/set-memory.ts).

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { SetMemory, camelot, keysMix, arcFor, SET_GAP_MS } from '../../src/show/set-memory.ts';
import { ShowDirector } from '../../src/show/director.ts';
import { INTENT, BURST } from '../../src/show/intents.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { settings } from '../../src/server/settings.ts';
import AutoShow from '../../src/auto-show.ts';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const files = fs.readdirSync(TRACKS).sort();
const load = (file) => {
  const doc = JSON.parse(fs.readFileSync(path.join(TRACKS, file), 'utf8'));
  return doc.analysis || doc;
};
const director = (history = null, extra = {}) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 60, history, ...extra,
});
const remembered = (plan, over = {}) => ({ key: 'before', at: 0, ...plan.memory, ...over });
const history = (tracks, setMinutes = 60) => ({ previous: tracks[tracks.length - 1] || null, recent: tracks, setMinutes });

// ── The wheel ───────────────────────────────────────────────────────────────

test('keys sit on the Camelot wheel the way a DJ reads it', () => {
  assert.deepStrictEqual(camelot('A minor'), { number: 8, minor: true });
  assert.deepStrictEqual(camelot('C major'), { number: 8, minor: false });
  assert.deepStrictEqual(camelot('G'), { number: 9, minor: false });
  assert.deepStrictEqual(camelot('E minor'), { number: 9, minor: true });
  assert.deepStrictEqual(camelot('Bb minor'), camelot('A# minor'));
  assert.strictEqual(camelot('H'), null);
});

test('keys mix one step round the wheel, or with their relative', () => {
  assert.ok(keysMix('A minor', 'C major'), 'relative major');
  assert.ok(keysMix('A minor', 'E minor'), 'a fifth up');
  assert.ok(keysMix('A minor', 'D minor'), 'a fifth down');
  assert.ok(keysMix('B major', 'F# major'), 'round the top of the wheel');
  assert.ok(!keysMix('A minor', 'F# major'), 'a clash');
  assert.ok(!keysMix('A minor', 'G major'), 'across the wheel');
  assert.ok(!keysMix(null, 'A minor'), 'an unknown key is not a mix');
});

// ── The memory ──────────────────────────────────────────────────────────────

test('a replan replaces its own entry, and an hour away starts a new set', () => {
  let now = 0;
  const memory = new SetMemory({ now: () => now });
  const entry = (key, drive = 0.5) => ({ key, paletteName: 'x', palette: [1], looks: {}, drive, musicalKey: null, blinder: false });
  memory.record(entry('a'));
  now = 3 * 60000;
  memory.record(entry('b'));
  memory.record(entry('b', 0.9));
  assert.strictEqual(memory.size, 2);
  assert.strictEqual(memory.history('b').previous.key, 'a', 'the track playing is not its own history');
  assert.strictEqual(memory.history('c').previous.drive, 0.9);
  assert.strictEqual(memory.history('c').setMinutes, 3);
  now += SET_GAP_MS + 1;
  assert.strictEqual(memory.history('c').previous, null, 'the night is over');
  memory.record(entry('c'));
  assert.strictEqual(memory.size, 1);
});

test('a peak earns the big gestures; a warm-up and a breather hold some back', () => {
  const t = (drive, blinder = false) => ({ key: String(drive), paletteName: 'x', palette: [], looks: {}, drive, musicalKey: null, blinder, at: 0 });
  assert.deepStrictEqual(arcFor(null, 0.8), { budget: 1, blinder: true, reason: 'first' });
  assert.strictEqual(arcFor(history([t(0.5)], 60), 0.8).reason, 'peak');
  assert.strictEqual(arcFor(history([t(0.5)], 5), 0.5).reason, 'warm-up');
  assert.ok(arcFor(history([t(0.5)], 5), 0.5).budget < 1);
  assert.strictEqual(arcFor(history([t(0.8)], 60), 0.5).reason, 'breather');
  assert.strictEqual(arcFor(history([t(0.6, true)], 60), 0.6).blinder, false, 'a blinder last track, and this is no peak');
  assert.strictEqual(arcFor(history([t(0.5, true)], 60), 0.8).blinder, true, 'a peak always has it');
  assert.strictEqual(arcFor(history([t(0.6, true), t(0.6), t(0.6)], 60), 0.6).blinder, true, 'two tracks without one earns it back');
});

// ── The director ────────────────────────────────────────────────────────────

test('never the same palette twice in a row', () => {
  for (const file of files) {
    const a = load(file);
    const alone = director().plan(a);
    const after = director(history([remembered(alone)])).plan(a);
    assert.notStrictEqual(after.paletteName, alone.paletteName, `${file}: ${alone.paletteName} twice`);
  }
});

test('a section does not open on the look the same section opened on last track', () => {
  let checked = 0;
  for (const file of files) {
    const a = load(file);
    const alone = director().plan(a);
    const after = director(history([remembered(alone)])).plan(a);
    for (const [role, pattern] of Object.entries(after.memory.looks)) {
      if (alone.memory.looks[role] === undefined) continue;
      assert.notStrictEqual(pattern, alone.memory.looks[role], `${file}: the ${role} on ${pattern} again`);
      checked++;
    }
  }
  assert.ok(checked >= 8, `roles compared: ${checked}`);
});

test('a track that mixes in keeps more of the last track\'s colours than one that clashes', () => {
  let mixed = 0;
  let clashed = 0;
  for (const file of files) {
    for (const other of files) {
      if (other === file) continue;
      const before = director().plan(load(other));
      const a = load(file);
      const key = [a.key, a.scale].filter(Boolean).join(' ');
      const mixKey = key;                        // the same key always mixes
      const clashKey = camelot(key) ? 'F# major' : null;
      if (!clashKey || keysMix(key, clashKey)) continue;
      const shared = (plan) => plan.palette.filter((c) => before.palette.includes(c)).length;
      mixed += shared(director(history([remembered(before, { musicalKey: mixKey })])).plan(a));
      clashed += shared(director(history([remembered(before, { musicalKey: clashKey })])).plan(a));
    }
  }
  assert.ok(mixed > clashed, `shared colours: ${mixed} after a mix, ${clashed} after a clash`);
});

function drops(plan) {
  return plan.intents.filter((i) => i.kind === INTENT.ACCENT && i.burst === BURST.BLINDER).length;
}

test('blinders are rationed across the night unless the track is a peak', () => {
  let rationed = 0;
  for (const file of files) {
    const a = load(file);
    const alone = director(null, { intensity: 90 }).plan(a);
    if (!drops(alone)) continue;
    const level = { ...alone.memory, drive: alone.memory.drive, blinder: true };
    const after = director(history([remembered(alone, level)]), { intensity: 90 }).plan(a);
    assert.strictEqual(drops(after), 0, `${file}: a blinder straight after one, at the same drive`);
    const peak = director(history([remembered(alone, { ...level, drive: alone.memory.drive - 0.3 })]), { intensity: 90 }).plan(a);
    assert.ok(drops(peak) > 0, `${file}: a peak keeps its blinder`);
    rationed++;
  }
  assert.ok(rationed >= 1, 'some fixture track spends a blinder');
});

test('a peak spends more accents than the same track as a breather', () => {
  const count = (plan) => plan.intents.filter((i) => i.kind === INTENT.ACCENT && !String(i.source).startsWith('drop')).length;
  let tracks = 0;
  for (const file of files) {
    const a = load(file);
    const alone = director().plan(a);
    // Four of the fixture analyses are older ones whose downbeats the tracker
    // was unsure of, and the contrast pass spends nothing on a bar line that
    // uncertain: there is no budget there for the arc to move.
    if (!count(alone)) continue;
    const peak = director(history([remembered(alone, { drive: alone.memory.drive - 0.3 })])).plan(a);
    const breather = director(history([remembered(alone, { drive: alone.memory.drive + 0.3 })])).plan(a);
    assert.ok(count(peak) > count(alone) && count(alone) > count(breather),
      `${file}: ${count(peak)} at a peak, ${count(alone)} on its own, ${count(breather)} as a breather`);
    tracks++;
  }
  assert.ok(tracks >= 1, 'a fixture track has bar accents to spend');
});

// ── The auto show ───────────────────────────────────────────────────────────

function show() {
  const s = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
  s._worker.shutdown();
  return s;
}

function play(s, file) {
  s.analysis = load(file);
  s.analysisKey = file;
  s.buildTimeline();
  s.start(() => 0);
  s.stop();
}

test('the auto show plans each track against the one it played before', () => {
  const s = show();
  play(s, files[0]);
  const first = s.paletteName;
  s.analysis = load(files[0]);
  s.analysisKey = files[0];
  s.buildTimeline();
  assert.strictEqual(s.paletteName, first, 'replanning the track playing is not a new track');
  play(s, files[1]);
  s.analysis = load(files[0]);
  s.analysisKey = 'the same record again';
  s.buildTimeline();
  assert.strictEqual(s.getClientState().set.tracks, 2);
  const again = s.paletteName;
  play(s, files[0]);
  assert.ok(again, 'planned');
});

test('with the memory off every track plans as the first of the night', () => {
  const was = settings._values.auto.setMemory;
  settings._values.auto.setMemory = false;
  try {
    const s = show();
    play(s, files[0]);
    const fresh = show();
    fresh.analysis = load(files[1]);
    fresh.buildTimeline();
    s.analysis = load(files[1]);
    s.analysisKey = files[1];
    s.buildTimeline();
    assert.strictEqual(s.paletteName, fresh.paletteName);
    assert.deepStrictEqual(s.intents, fresh.intents);
  } finally {
    settings._values.auto.setMemory = was;
  }
});
