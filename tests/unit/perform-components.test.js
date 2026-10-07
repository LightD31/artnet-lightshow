// The Perform parts, rendered in Node as components.test.js does: the
// photosensitivity dialog, the pads' holds and safety asks, the palette
// override strip, stop all voices, the transport, the audio meters, and the
// audio feed's subscription in state.js.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');

async function load() {
  const result = await esbuild.build({
    stdin: {
      contents: `
        export { render as html } from 'preact-render-to-string';
        export { h } from 'preact';
        export { store, librarySig, socket, wantAudio, audioFeedSig } from './public-src/state.js';
        export { Photosensitivity, acknowledgeThen, guardRapid, isAcknowledged } from './public-src/components/Photosensitivity.jsx';
        export { PhotosensitivityConfirm } from './public-src/components/Effects.jsx';
        export { StrobePad } from './public-src/components/StrobePad.jsx';
        export { Pads } from './public-src/components/Pads.jsx';
        export { CommandBar } from './public-src/components/CommandBar.jsx';
        export { createPadPresses, rapidPad, padKey } from './public-src/voice-pad.js';
        export { createVoiceHolds } from './public-src/hold-control.js';
        export { PalettePads, PaletteOverride, overrideBody, activeOverride, stopAllVoices } from './public-src/components/Perform.jsx';
        export { Transport, positionText, beatsPerBar, loopBody, laneRows } from './public-src/components/Transport.jsx';
        export { presetNameOf } from './public-src/preview-inputs.js';
        export { AudioMeters, meterRows, splClass, latencyText } from './public-src/components/AudioMeters.jsx';
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.js': 'jsx' },
    alias: { 'socket.io-client': path.join(ROOT, 'tests', 'helpers', 'fake-socket-io.js') },
    logLevel: 'silent',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perform-components-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

function given(state) {
  ui.store.applySnapshot({ versions: {}, state: { bpm: 120, pads: { layout: [], lit: [] }, voices: [], strobe: { active: false, settings: {} }, ...state } });
}

/** fetch answered with `body`; the calls made, as [path, init]. */
function fakeFetch(body = { ok: true }) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (p, init) => { calls.push([p, init]); return { ok: body.ok !== false, json: async () => body }; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the photosensitivity dialog names what flashes and both answers', () => {
  const html = ui.html(ui.h(ui.Photosensitivity, { name: 'Strobe', onConfirm: () => {}, onCancel: () => {} }));
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-labelledby="photosensitivity-title"/);
  assert.match(html, /<strong>Strobe<\/strong>/);
  assert.match(html, /photosensitive epilepsy/i);
  assert.match(html, />I understand — play it</);
  assert.match(html, />Cancel</);
});

test('strobe notice opens a server-wide acknowledgement dialog', () => {
  const html = ui.html(ui.h(ui.Photosensitivity, { allow: true, onConfirm: () => {}, onCancel: () => {} }));
  assert.match(html, /<strong>The strobe and every fast-flashing effect<\/strong> flash the lamps/);
  assert.match(html, /Allowing them acknowledges this for the whole server, once/);
  assert.match(html, />I understand — allow them</);
  assert.doesNotMatch(html, /play it/);
});

test('the Effects view asks through the same dialog', () => {
  assert.strictEqual(ui.PhotosensitivityConfirm, ui.Photosensitivity);
});

test('a rapid action runs at once when acknowledged and asks once otherwise', () => {
  const ran = [];
  const asked = [];
  assert.strictEqual(ui.guardRapid(true, 'Strobe', () => ran.push(1), (q) => asked.push(q)), true);
  assert.deepStrictEqual(ran, [1]);
  assert.strictEqual(ui.guardRapid(false, 'Strobe', () => ran.push(2), (q) => asked.push(q)), false);
  assert.deepStrictEqual(ran, [1]);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].name, 'Strobe');
  assert.strictEqual(ui.isAcknowledged({ photosensitivityAcknowledged: true }), true);
  assert.strictEqual(ui.isAcknowledged(null), false);
});

test('confirming posts the acknowledgement and runs only once the server took it', async () => {
  let f = fakeFetch({ ok: true, photosensitivityAcknowledged: true });
  const ran = [];
  try {
    assert.strictEqual(await ui.acknowledgeThen(() => ran.push('go')), true);
    assert.strictEqual(f.calls[0][0], '/api/safety/acknowledge');
    assert.strictEqual(f.calls[0][1].method, 'POST');
    assert.deepStrictEqual(ran, ['go']);
  } finally { f.restore(); }
  f = fakeFetch({ ok: false, error: 'disk full' });
  try {
    assert.strictEqual(await ui.acknowledgeThen(() => ran.push('again')), false);
    assert.deepStrictEqual(ran, ['go']);
  } finally { f.restore(); }
});

test('before the acknowledgement the strobe pad asks first; after it, it holds', () => {
  given({ safety: { photosensitivityAcknowledged: false } });
  let html = ui.html(ui.h(ui.StrobePad));
  assert.match(html, /class="strobe-hold[^"]*"[^>]*data-safety="ask"/);
  assert.match(html, />confirm first</);
  given({ safety: { photosensitivityAcknowledged: true } });
  html = ui.html(ui.h(ui.StrobePad));
  assert.doesNotMatch(html, /data-safety="ask"/);
  assert.match(html, />hold</);
});

test('a strobe pad in the bank asks first too, and a look pad never does', () => {
  const layout = [
    { bank: 0, slot: 0, label: 'Strobe', accent: '#FFFFFF', content: { kind: 'strobe', id: 'strobe' }, launch: 'hold', quantise: 0, targets: 'shared' },
    { bank: 0, slot: 1, label: 'Glow', accent: '#FF8800', content: { kind: 'preset', id: 'energy.glow' }, launch: 'hold', quantise: 0, targets: 'shared' },
  ];
  given({ safety: { photosensitivityAcknowledged: false }, pads: { layout, lit: [] } });
  let html = ui.html(ui.h(ui.Pads, { initialBank: 0 }));
  assert.match(html, /data-slot="0"[^>]*data-safety="ask"/);
  assert.doesNotMatch(html, /data-slot="1"[^>]*data-safety="ask"/);
  given({ safety: { photosensitivityAcknowledged: true }, pads: { layout, lit: [] } });
  html = ui.html(ui.h(ui.Pads, { initialBank: 0 }));
  assert.doesNotMatch(html, /data-safety="ask"/);
});

/** The holds' messages, a window to dispatch on, and the presses under test. */
function presses() {
  const sent = [];
  const holds = ui.createVoiceHolds((p) => { sent.push(p); return true; });
  const win = new globalThis.EventTarget();
  const lit = [];
  const p = ui.createPadPresses(holds, win, (keys) => lit.push([...keys]));
  const up = (type, fields) => win.dispatchEvent(Object.assign(new globalThis.Event(type), fields));
  const released = () => sent.filter((m) => m.action === 'release').map((m) => `${m.pad.bank}-${m.pad.slot}`);
  return { holds, win, p, up, sent, lit, released };
}
const target = (bank, slot) => ({ pad: { bank, slot } });

test('held pads release on pointer-up after a bank switch', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 0), target(0, 0), { pointer: 1 });
  // The second finger taps bank B: A1 is no longer rendered at all.
  t.p.press(ui.padKey(1, 0), target(1, 0), { pointer: 2 });
  t.up('pointerup', { pointerId: 2 });
  assert.deepStrictEqual(t.released(), ['1-0']);
  t.up('pointerup', { pointerId: 1 });
  assert.deepStrictEqual(t.released(), ['1-0', '0-0']);
  assert.deepStrictEqual(t.lit.at(-1), []);
  t.p.dispose();
});

test('a held pad lets go on pointercancel and on its key\'s up anywhere', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 1), target(0, 1), { pointer: 5 });
  t.p.press(ui.padKey(0, 2), target(0, 2), { key: 'Enter' });
  t.up('keyup', { key: ' ' });
  t.up('pointerup', { pointerId: 9 });
  assert.deepStrictEqual(t.released(), []);
  t.up('pointercancel', { pointerId: 5 });
  t.up('keyup', { key: 'Enter' });
  assert.deepStrictEqual(t.released(), ['0-1', '0-2']);
  t.p.dispose();
});

test('held pads release when their rendered slot disappears', () => {
  for (const shown of [new Set(), new Set([ui.padKey(1, 0)])]) {
    const t = presses();
    t.p.press(ui.padKey(0, 3), target(0, 3), { pointer: 1 });
    t.p.keep(new Set([ui.padKey(0, 3), ...shown]));
    assert.deepStrictEqual(t.released(), []);
    // Edit pads (nothing rendered as a hold), bank B shown, or the pad turned into a tap pad.
    t.p.keep(shown);
    assert.deepStrictEqual(t.released(), ['0-3']);
    assert.deepStrictEqual(t.lit.at(-1), []);
    t.up('pointerup', { pointerId: 1 });
    assert.deepStrictEqual(t.released(), ['0-3']);
    t.p.dispose();
  }
});

test('unmounting lets go, and a later up anywhere sends nothing more', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 4), target(0, 4), { pointer: 1 });
  t.p.dispose();
  assert.deepStrictEqual(t.released(), ['0-4']);
  t.up('pointerup', { pointerId: 1 });
  assert.strictEqual(t.sent.length, 2);
});

test('a disconnect clears the held pads and nothing presses again by itself', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 5), target(0, 5), { pointer: 1 });
  assert.deepStrictEqual(t.lit.at(-1), ['p0-5']);
  t.holds.releaseAll();
  assert.deepStrictEqual(t.lit.at(-1), []);
  assert.strictEqual(t.p.mine(ui.padKey(0, 5), 'pointer', 1), false);
  assert.strictEqual(t.sent.filter((m) => m.action === 'press').length, 1);
  t.p.dispose();
});

test('refused pad presses leave earlier holds active', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 2), target(0, 2), { pointer: 1 });
  t.p.press(ui.padKey(0, 0), target(0, 0), { pointer: 2 });
  t.holds.refuse();
  assert.deepStrictEqual(t.holds.held(), ['p0-2']);
  assert.deepStrictEqual(t.lit.at(-1), ['p0-2']);
  t.p.dispose();
});

test('pad refusals only clear their matching press', () => {
  const t = presses();
  t.p.press(ui.padKey(0, 0), target(0, 0), { pointer: 1 });
  const first = t.sent.findLast((m) => m.action === 'press').token;
  t.p.press(ui.padKey(0, 2), target(0, 2), { pointer: 2 });
  // The refusal of the first press arrives after the second is down.
  t.holds.refuse(first);
  assert.deepStrictEqual(t.holds.held(), ['p0-2'], 'the newer press stays');
  // Pressed again, then the old refusal arrives a second time: the new press of that pad is not it.
  t.p.press(ui.padKey(0, 0), target(0, 0), { pointer: 3 });
  t.holds.refuse(first);
  assert.deepStrictEqual(t.holds.held().sort(), ['p0-0', 'p0-2']);
  t.p.dispose();
});

const CATALOGUE_ROWS = [
  { id: 'energy.whiteStrobe', rapidFlash: true }, { id: 'energy.glow', rapidFlash: false }, { id: 'upFlash', rapidFlash: true }, { id: 'upCalm' },
];
const pad = (slot, label, content, launch = 'hold') => ({ bank: 0, slot, label, accent: '#FFFFFF', content, launch, quantise: 0, targets: 'shared' });

test('pad acknowledgement follows rapid metadata', () => {
  const mine = [{ id: 'u1', rapidFlash: true }, { id: 'u2', rapidFlash: false }];
  const rapid = (content) => ui.rapidPad({ content }, CATALOGUE_ROWS, mine);
  assert.strictEqual(rapid({ kind: 'strobe', id: 'strobe' }), true);
  assert.strictEqual(rapid({ kind: 'preset', id: 'energy.whiteStrobe' }), true);
  assert.strictEqual(rapid({ kind: 'preset', id: 'energy.glow' }), false);
  assert.strictEqual(rapid({ kind: 'preset', id: 'u1' }), true);
  assert.strictEqual(rapid({ kind: 'preset', id: 'u2' }), false);
  assert.strictEqual(rapid({ kind: 'pattern', id: 'upFlash' }), true);
  assert.strictEqual(rapid({ kind: 'pattern', id: 'upCalm' }), false);
  assert.strictEqual(rapid({ kind: 'pattern', id: 'unknown' }), false);
  assert.strictEqual(ui.rapidPad({ content: null }, CATALOGUE_ROWS, mine), false);
});

test('rapid pad controls gate presses until acknowledgement', () => {
  const layout = [
    pad(0, 'White', { kind: 'preset', id: 'energy.whiteStrobe' }),
    pad(1, 'Glow', { kind: 'preset', id: 'energy.glow' }),
    pad(2, 'Flash', { kind: 'pattern', id: 'upFlash' }, 'once'),
    pad(3, 'Strobe', { kind: 'strobe', id: 'strobe' }),
  ];
  given({ safety: { photosensitivityAcknowledged: false }, pads: { layout, lit: [] }, patterns: CATALOGUE_ROWS, effects: [] });
  const deck = ui.html(ui.h(ui.Pads, { initialBank: 0 }));
  const strip = ui.html(ui.h(ui.CommandBar, {}));
  for (const html of [deck, strip]) {
    const asking = [...html.matchAll(/<button[^>]*data-safety="ask"[^>]*>/g)].length;
    assert.strictEqual(asking, 3, html);
    assert.doesNotMatch(html, /title="Glow[^"]*"[^>]*data-safety="ask"/);
  }
  given({ safety: { photosensitivityAcknowledged: true }, pads: { layout, lit: [] }, patterns: CATALOGUE_ROWS, effects: [] });
  assert.doesNotMatch(ui.html(ui.h(ui.Pads, { initialBank: 0 })), /data-safety="ask"/);
  assert.doesNotMatch(ui.html(ui.h(ui.CommandBar, {})), /data-safety="ask"/);
});

test('a strip pad with no label is named by its content, as on the deck', () => {
  given({ safety: { photosensitivityAcknowledged: true }, pads: { layout: [pad(0, '', { kind: 'preset', id: 'energy.glow' })], lit: [] } });
  const html = ui.html(ui.h(ui.CommandBar, {}));
  const deck = ui.html(ui.h(ui.Pads, { initialBank: 0 }));
  const name = html.match(/class="cb-energy-name">([^<]+)</)?.[1];
  assert.ok(name);
  assert.equal(name, deck.match(/class="pad-label">([^<]+)</)?.[1]);
});

const BUILTIN = [{ id: 'ldjFire', app: 'ldj', colours: ['#FF0000', '#FF8800'] }, { id: 'hdDefault', app: 'hd', colours: ['#00FF00', { random: true }] }];
const USER = [{ id: 'mine', name: 'Mine', colours: ['#123456'] }];

test('palette override strip orders and selects palettes', () => {
  ui.librarySig.value = { status: 'ok', families: [], builtin: [], user: [], palettes: { builtin: BUILTIN, user: USER } };
  given({ paletteOverride: null, userPalettes: USER });
  let html = ui.html(ui.h(ui.PaletteOverride));
  const names = [...html.matchAll(/class="override-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Off', 'Ldj Fire', 'Hue Dynamics default', 'Mine']);
  assert.match(html, /aria-pressed="true"[^>]*data-override="off"/);
  given({ paletteOverride: ['#123456'], userPalettes: USER });
  html = ui.html(ui.h(ui.PaletteOverride));
  assert.match(html, /aria-pressed="true"[^>]*data-override="mine"/);
  assert.match(html, /aria-pressed="false"[^>]*data-override="off"/);
});

test('the override names a palette by id, and is matched back by its colours', () => {
  assert.deepStrictEqual(ui.overrideBody(USER[0]), { paletteId: 'mine' });
  assert.strictEqual(ui.activeOverride(['#ff0000', '#ff8800'], [...BUILTIN, ...USER]), 'ldjFire');
  assert.strictEqual(ui.activeOverride(null, BUILTIN), 'off');
  assert.strictEqual(ui.activeOverride(['#ABCDEF'], BUILTIN), null);
});

test('stop all voices sends DELETE /api/voices', async () => {
  const f = fakeFetch({ ok: true, stopped: 2 });
  try {
    await ui.stopAllVoices();
    assert.deepStrictEqual(f.calls.map(([p, init]) => [p, init.method]), [['/api/voices', 'DELETE']]);
  } finally { f.restore(); }
});

test('a named random override lights its palette button with live swatches', () => {
  ui.librarySig.value = { status: 'ok', palettes: { builtin: BUILTIN, user: USER } };
  given({ paletteOverride: ['#00FF00', '#2A00FF'], paletteOverrideId: 'hdDefault', userPalettes: USER });
  const html = ui.html(ui.h(ui.PaletteOverride));
  assert.match(html, /aria-pressed="true"[^>]*data-override="hdDefault"/);
  const lit = html.match(/<button[^>]*data-override="hdDefault"[^>]*>.*?<\/button>/)[0];
  assert.match(lit, /background:\s*#2A00FF/);
  assert.doesNotMatch(lit, /class="random"/);
});

test('an unknown palette id falls back to matching fixed colours', () => {
  assert.equal(ui.activeOverride(['#FF0000', '#FF8800'], BUILTIN, 'gone'), 'ldjFire');
  assert.equal(ui.activeOverride(['#123456'], BUILTIN, 'gone'), null);
});

test('clearing the override ignores its old palette id', () => {
  assert.equal(ui.activeOverride(null, BUILTIN, 'hdDefault'), 'off');
});

for (const [name, palette, override, hint] of [
  ['own palette', ['#FF0000'], null, true],
  ['look palette', null, null, false],
  ['override', null, ['#00FF00'], true],
]) {
  test(`look palettes indicate whether the base uses ${name}`, () => {
    ui.librarySig.value = { builtin: [{ id: 'effect', spec: { palette } }], user: [] };
    given({ pattern: 'effect', paletteOverride: override, palettes: [{ id: 'look', colors: { 4: [0] } }] });
    const html = ui.html(ui.h(ui.PalettePads));
    assert.equal(/role="status"/.test(html), hint);
    assert.match(html, /class="perform-palette /);
  });
}

const SEQ = {
  id: 'set1', name: 'Set one', timeSignature: { beats: 4, unit: 4 },
  lanes: [{ id: 'front', name: 'Front' }, { id: 'back', name: '' }], clips: [{ id: 'c1', presetId: 'hd.neonDomino' }, { id: 'c2', presetId: 'mine-1' }, { id: 'c3', effect: { kind: 'energy.glow' } }],
  loop: { on: false, startBeat: 0, endBeat: 16 },
};
const STATUS = {
  loaded: { id: 'set1', name: 'Set one' }, revision: 3, mode: 'linear', playing: true, paused: false, stopped: null,
  beat: 9.5, bar: 3, loop: { on: false, startBeat: 0, endBeat: 16 }, lanes: [{ id: 'front', clip: 'c1' }, { id: 'back', clip: null }], error: null,
};

test('the position reads bars.beats, and the bar follows the time signature', () => {
  assert.strictEqual(ui.beatsPerBar({ beats: 4, unit: 4 }), 4);
  assert.strictEqual(ui.beatsPerBar({ beats: 6, unit: 8 }), 3);
  assert.strictEqual(ui.beatsPerBar(undefined), 4);
  assert.strictEqual(ui.positionText(STATUS, 4), '3.2');
  assert.strictEqual(ui.positionText({ ...STATUS, beat: 0, bar: 1 }, 4), '1.1');
  assert.strictEqual(ui.positionText(null, 4), '–');
});

test('each lane shows its playing clip by its preset\'s name, a saved preset\'s first', () => {
  const nameOf = ui.presetNameOf([{ id: 'mine-1', name: 'My wash' }]);
  assert.deepStrictEqual(ui.laneRows(STATUS, SEQ, nameOf), [{ id: 'front', lane: 'Front', clip: 'Neon Domino' }, { id: 'back', lane: 'back', clip: null }]);
  const lanes = (clip) => ui.laneRows({ ...STATUS, lanes: [{ id: 'front', clip }] }, SEQ, nameOf)[0].clip;
  assert.strictEqual(lanes('c2'), 'My wash');
  assert.strictEqual(lanes('c3'), 'Effect', 'an effect of its own, no preset');
  assert.strictEqual(lanes('gone'), 'gone', 'a clip the page has not fetched yet: its id');
});

test('loop flips the loaded region on and off, and is unavailable without one', () => {
  assert.deepStrictEqual(ui.loopBody(STATUS), { on: true, startBeat: 0, endBeat: 16 });
  assert.deepStrictEqual(ui.loopBody({ ...STATUS, loop: { on: true, startBeat: 4, endBeat: 8 } }), { on: false, startBeat: 4, endBeat: 8 });
  assert.strictEqual(ui.loopBody({ ...STATUS, loop: null }), null);
});

test("transport lists available sequences and marks the loaded one", () => {
  given({ sequence: STATUS, sequences: [{ id: 'set1', name: 'Set one' }, { id: 'set2', name: 'Set two' }] });
  const html = ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } }));
  assert.match(html, /aria-label="Sequence"/);
  assert.match(html, /<option value="set1" selected[^>]*>Set one</);
  assert.match(html, /<option value="set2"[^>]*>Set two</);
});

test("playing transport exposes clip position and controls", () => {
  given({ sequence: STATUS, sequences: [{ id: 'set1', name: 'Set one' }, { id: 'set2', name: 'Set two' }] });
  const html = ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } }));
  for (const label of ['Pause', 'Stop', 'Next', 'Shuffle', 'Loop']) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(html, /class="transport-position"[^>]*>3\.2</);
  assert.match(html, /Front[\s\S]*Neon Domino/);
});

test("paused transport offers play and unloading", () => {
  given({ sequence: { ...STATUS, playing: false, paused: true } });
  assert.match(ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } })), /aria-label="Play"/);
  assert.match(ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } })), /<option value(="")?[^>]*>No sequence \(back to the look\)</);
});

test('sequence picker follows shelves received from other clients', () => {
  given({ sequence: STATUS, sequences: [{ id: 'set1', name: 'Set one' }] });
  assert.doesNotMatch(ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } })), /Saved on the tablet/);
  given({ sequence: STATUS, sequences: [{ id: 'set1', name: 'Set one' }, { id: 'tab', name: 'Saved on the tablet' }] });
  assert.match(ui.html(ui.h(ui.Transport, { initial: { sequence: SEQ } })), /<option value="tab"[^>]*>Saved on the tablet</);
});

test('with nothing loaded the transport offers the picker and no position', () => {
  given({ sequence: { ...STATUS, loaded: null, playing: false, lanes: [] }, sequences: [{ id: 'set1', name: 'Set one' }] });
  const html = ui.html(ui.h(ui.Transport, { initial: { sequence: null } }));
  assert.match(html, /<option value(="")? selected[^>]*>Pick a sequence</);
  assert.match(html, /aria-label="Play"[^>]*disabled/);
});

const FEED = {
  t: 1, party: { full: 0.8, bass: 0.5, mid: 0.25, high: 0 },
  disco: { gate: [1, 0, 1], level: [0.9, 0.1, 0.6], hit: [true, false, false] },
  spl: { db: -12, level: 0.7, beat: 'loud', section: 'soft' },
};

test("meter rows express normalized audio levels as percentages", () => {
  assert.deepStrictEqual(ui.meterRows(FEED.party).map((r) => [r.key, r.pct]), [['full', 80], ['bass', 50], ['mid', 25], ['high', 0]]);
});

test("missing audio levels render zeroed meters", () => {
  assert.deepStrictEqual(ui.meterRows(null).map((r) => r.pct), [0, 0, 0, 0]);
});

test("SPL classes follow beat or section loudness", () => {
  assert.strictEqual(ui.splClass(FEED.spl), 'loud');
  assert.strictEqual(ui.splClass({ beat: null, section: 'quiet' }), 'quiet');
  assert.strictEqual(ui.splClass(null), null);
});

test("latency text preserves sign and handles missing readings", () => {
  assert.strictEqual(ui.latencyText(40), '+40 ms');
  assert.strictEqual(ui.latencyText(-25), '−25 ms');
  assert.strictEqual(ui.latencyText(undefined), '–');
});

test("audio panel selects the live audio mode", () => {
  given({ audio: { mode: 'reactive', listening: true, levels: FEED.party, spl: FEED.spl, detectors: { spl: {}, disco: { owner: null, bands: [], globals: {} } } } });
  ui.audioFeedSig.value = FEED;
  const html = ui.html(ui.h(ui.AudioMeters, { latencyMs: 40 }));
  assert.match(html, /<select[^>]*aria-label="Audio mode"/);
  for (const m of ['off', 'tempo', 'reactive']) assert.match(html, new RegExp(`<option value="${m}"`));
  assert.match(html, /<option value="reactive" selected/);
});

test("audio panel renders meter levels", () => {
  given({ audio: { mode: 'reactive', listening: true, levels: FEED.party, spl: FEED.spl, detectors: { spl: {}, disco: { owner: null, bands: [], globals: {} } } } });
  ui.audioFeedSig.value = FEED;
  const html = ui.html(ui.h(ui.AudioMeters, { latencyMs: 40 }));
  assert.strictEqual((html.match(/role="meter"/g) || []).length, 4);
  assert.match(html, /aria-label="bass"[^>]*aria-valuenow="50"/);
});

test("audio panel renders detector gate states", () => {
  given({ audio: { mode: 'reactive', listening: true, levels: FEED.party, spl: FEED.spl, detectors: { spl: {}, disco: { owner: null, bands: [], globals: {} } } } });
  ui.audioFeedSig.value = FEED;
  const html = ui.html(ui.h(ui.AudioMeters, { latencyMs: 40 }));
  assert.strictEqual((html.match(/class="gate open"/g) || []).length, 1);
  assert.strictEqual((html.match(/class="gate"/g) || []).length, 2);
});

test("audio panel renders SPL and latency readings", () => {
  given({ audio: { mode: 'reactive', listening: true, levels: FEED.party, spl: FEED.spl, detectors: { spl: {}, disco: { owner: null, bands: [], globals: {} } } } });
  ui.audioFeedSig.value = FEED;
  const html = ui.html(ui.h(ui.AudioMeters, { latencyMs: 40 }));
  assert.match(html, /class="spl-chip loud"/);
  assert.match(html, /\+40 ms/);
});

test('audio feed subscriptions share one connection', () => {
  ui.socket.connected = true;
  ui.socket.sent.length = 0;
  const a = ui.wantAudio();
  const b = ui.wantAudio();
  assert.deepStrictEqual(ui.socket.sent, [['subscribe', ['audio']]]);
  a();
  assert.strictEqual(ui.socket.sent.length, 1);
  b();
  assert.deepStrictEqual(ui.socket.sent, [['subscribe', ['audio']], ['unsubscribe', ['audio']]]);
  ui.socket.connected = false;
});
