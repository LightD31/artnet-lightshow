// Task 23b's Perform parts, rendered in Node as components.test.js does:
// the photosensitivity dialog, the palette override strip, the transport,
// the audio meters, and the audio feed's subscription in state.js.

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
        export { PaletteOverride, overrideBody, activeOverride } from './public-src/components/Perform.jsx';
        export { Transport, positionText, beatsPerBar, loopBody, laneRows } from './public-src/components/Transport.jsx';
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

const BUILTIN = [{ id: 'ldjFire', app: 'ldj', colours: ['#FF0000', '#FF8800'] }, { id: 'hdDefault', app: 'hd', colours: ['#00FF00', { random: true }] }];
const USER = [{ id: 'mine', name: 'Mine', colours: ['#123456'] }];

test('the palette override strip: Off first, built-in then your palettes, the one on stage pressed', () => {
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

const SEQ = {
  id: 'set1', name: 'Set one', timeSignature: { beats: 4, unit: 4 },
  lanes: [{ id: 'front', name: 'Front' }, { id: 'back', name: '' }], clips: [{ id: 'c1', name: 'Intro' }],
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

test('each lane shows its playing clip by name', () => {
  assert.deepStrictEqual(ui.laneRows(STATUS, SEQ), [{ id: 'front', lane: 'Front', clip: 'Intro' }, { id: 'back', lane: 'back', clip: null }]);
});

test('loop flips the loaded region on and off, and is unavailable without one', () => {
  assert.deepStrictEqual(ui.loopBody(STATUS), { on: true, startBeat: 0, endBeat: 16 });
  assert.deepStrictEqual(ui.loopBody({ ...STATUS, loop: { on: true, startBeat: 4, endBeat: 8 } }), { on: false, startBeat: 4, endBeat: 8 });
  assert.strictEqual(ui.loopBody({ ...STATUS, loop: null }), null);
});

test('the transport shows the sequence, its position, the clips and the controls', () => {
  given({ sequence: STATUS });
  const html = ui.html(ui.h(ui.Transport, { initial: { sequences: [{ id: 'set1', name: 'Set one' }, { id: 'set2', name: 'Set two' }], sequence: SEQ } }));
  assert.match(html, /aria-label="Sequence"/);
  assert.match(html, /<option value="set1" selected[^>]*>Set one</);
  assert.match(html, /<option value="set2"[^>]*>Set two</);
  for (const label of ['Pause', 'Stop', 'Next', 'Shuffle', 'Loop']) assert.match(html, new RegExp(`aria-label="${label}"`));
  assert.match(html, /class="transport-position"[^>]*>3\.2</);
  assert.match(html, /Front[\s\S]*Intro/);
  given({ sequence: { ...STATUS, playing: false, paused: true } });
  assert.match(ui.html(ui.h(ui.Transport, { initial: { sequences: [], sequence: SEQ } })), /aria-label="Play"/);
});

test('with nothing loaded the transport offers the picker and no position', () => {
  given({ sequence: { ...STATUS, loaded: null, playing: false, lanes: [] } });
  const html = ui.html(ui.h(ui.Transport, { initial: { sequences: [{ id: 'set1', name: 'Set one' }], sequence: null } }));
  assert.match(html, /<option value(="")? selected[^>]*>Pick a sequence</);
  assert.match(html, /aria-label="Play"[^>]*disabled/);
});

const FEED = {
  t: 1, party: { full: 0.8, bass: 0.5, mid: 0.25, high: 0 },
  disco: { gate: [1, 0, 1], level: [0.9, 0.1, 0.6], hit: [true, false, false] },
  spl: { db: -12, level: 0.7, beat: 'loud', section: 'soft' },
};

test('the meters read the party levels as percentages and the band gates as open or shut', () => {
  assert.deepStrictEqual(ui.meterRows(FEED.party).map((r) => [r.key, r.pct]), [['full', 80], ['bass', 50], ['mid', 25], ['high', 0]]);
  assert.deepStrictEqual(ui.meterRows(null).map((r) => r.pct), [0, 0, 0, 0]);
  assert.strictEqual(ui.splClass(FEED.spl), 'loud');
  assert.strictEqual(ui.splClass({ beat: null, section: 'quiet' }), 'quiet');
  assert.strictEqual(ui.splClass(null), null);
  assert.strictEqual(ui.latencyText(40), '+40 ms');
  assert.strictEqual(ui.latencyText(-25), '−25 ms');
  assert.strictEqual(ui.latencyText(undefined), '–');
});

test('the audio panel: the mode select, the meters, the gates, the SPL chip and the latency', () => {
  given({ audio: { mode: 'reactive', listening: true, levels: FEED.party, spl: FEED.spl, detectors: { spl: {}, disco: { owner: null, bands: [], globals: {} } } } });
  ui.audioFeedSig.value = FEED;
  const html = ui.html(ui.h(ui.AudioMeters, { latencyMs: 40 }));
  assert.match(html, /<select[^>]*aria-label="Audio mode"/);
  for (const m of ['off', 'tempo', 'reactive']) assert.match(html, new RegExp(`<option value="${m}"`));
  assert.match(html, /<option value="reactive" selected/);
  assert.strictEqual((html.match(/role="meter"/g) || []).length, 4);
  assert.match(html, /aria-label="bass"[^>]*aria-valuenow="50"/);
  // A band is open while it is hit, not whenever it has a threshold.
  assert.strictEqual((html.match(/class="gate open"/g) || []).length, 1);
  assert.strictEqual((html.match(/class="gate"/g) || []).length, 2);
  assert.match(html, /class="spl-chip loud"/);
  assert.match(html, /\+40 ms/);
});

test('the audio feed is subscribed once for any number of meters and dropped with the last', () => {
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
