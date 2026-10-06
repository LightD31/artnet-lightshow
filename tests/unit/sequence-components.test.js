// The Sequence and Matrix views, rendered in Node as tests/unit/components.test.js
// renders the others: bundled by esbuild with a socket that never connects,
// drawn by preact-render-to-string from a state snapshot and the view's
// initial data. The beat ruler's drawing is checked against a recording context.

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
        export { store, librarySig } from './public-src/state.js';
        export { Sequence, laneStack, moveClip, resizeClip, putSequence, automationStart, newClip, commandAs, createTextDraft, parseNumber } from './public-src/components/Sequence.jsx';
        export { Matrix, MATRIX_MODES, createMatrixHolds } from './public-src/components/Matrix.jsx';
        export { drawRuler, drawClips } from './public-src/timeline-renderer.js';
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sequence-components-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

function given(state) {
  ui.store.applySnapshot({ versions: {}, state: {
    bpm: 128, running: true, fixtures: [{ id: 1, name: 'Left' }, { id: 2, name: 'Right' }],
    sequence: null, ...state,
  } });
}

const SEQ = {
  id: 'friday', name: 'Friday', mode: 'arrangement', bpm: null, timeSignature: { beats: 4, unit: 4 },
  musicMode: null, loop: null, snap: 1,
  lanes: [
    { id: 'a', kind: 'shared', name: 'Base', mute: false, solo: false },
    { id: 't1', kind: 'track', fixtureId: 1, name: 'Left', mute: false, solo: false },
    { id: 'b', kind: 'shared', name: 'Accents', mute: false, solo: false },
  ],
  clips: [
    { id: 'c1', laneId: 'a', startBeat: 0, lengthBeats: 16, loopBeats: 4, presetId: 'ldj.scatter-strobe', targets: 'lane', mute: false },
    { id: 'c2', laneId: 'b', startBeat: 8, lengthBeats: 4, loopBeats: 4, presetId: 'hd.neon-domino', targets: [1, 2], mute: true },
  ],
  commands: [{ id: 'k1', atBeat: 16, type: 'tempo', value: 132 }],
  automation: { tempo: null, brightness: { mode: 'sine', period: 8, min: 0.2, max: 1, growing: true } },
  options: { autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null },
};
const STATUS = {
  loaded: { id: 'friday', name: 'Friday' }, revision: 3, mode: 'arrangement', playing: true, paused: false,
  stopped: null, beat: 9.5, bar: 3, loop: null, lanes: [{ id: 'a', clip: 'c1' }, { id: 'b', clip: null }], error: null,
};
const SHELF = [{ id: 'friday', name: 'Friday' }, { id: 'warmup', name: 'Warm-up' }];
const PATTERNS = [{ id: 'p1', name: 'Four on the floor', lengthBeats: 16, lanes: [] }];
const count = (html, needle) => html.split(needle).length - 1;

function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : (...args) => calls.push([key, ...args])),
    set: (target, key, value) => { target[key] = value; calls.push([`set:${String(key)}`, value]); return true; },
  });
  return { ctx, calls };
}

test('drawRuler draws a tick per beat and numbers each bar from 1', () => {
  const { ctx, calls } = recorder();
  ui.drawRuler(ctx, { fromBeat: 0, toBeat: 8, beatsPerBar: 4, width: 800, height: 20 });
  const labels = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepStrictEqual(labels, ['1', '2', '3']);
  assert.strictEqual(calls.filter((c) => c[0] === 'moveTo').length, 9, 'beats 0..8, ends included');
});

test('drawClips draws each clip in its lane\'s row at its beat, muted ones dimmed', () => {
  const { ctx, calls } = recorder();
  ui.drawClips(ctx, SEQ.clips, { laneIds: ['a', 'b'], fromBeat: 0, toBeat: 16, width: 800, rowHeight: 30, top: 20 });
  const rects = calls.filter((c) => c[0] === 'fillRect');
  assert.strictEqual(rects.length, 2);
  assert.deepStrictEqual(rects[0].slice(1, 5), [0, 22, 800, 26]);
  assert.deepStrictEqual(rects[1].slice(1, 5), [400, 52, 200, 26]);
  assert.ok(calls.some((c) => c[0] === 'set:globalAlpha' && c[1] < 1), 'a muted clip is drawn faint');
});

test('the lane stack puts shared lanes in priority order, then a track per fixture', () => {
  assert.deepStrictEqual(ui.laneStack(SEQ.lanes).map((l) => l.id), ['a', 'b', 't1']);
});

test('dragging a clip snaps to the grid and never before beat 0; resizing keeps one grid step', () => {
  const clip = SEQ.clips[1];
  assert.strictEqual(ui.moveClip(clip, 2.4, 1).startBeat, 10);
  assert.strictEqual(ui.moveClip(clip, -20, 1).startBeat, 0);
  assert.strictEqual(ui.moveClip(clip, 0.3, 0.5).startBeat, 8.5);
  assert.strictEqual(ui.resizeClip(clip, -10, 1).lengthBeats, 1);
  assert.strictEqual(ui.resizeClip(clip, 3.2, 1).lengthBeats, 7);
});

test('with nothing loaded the Sequence view offers the saved sequences, one tap each', () => {
  given({});
  const html = ui.html(ui.h(ui.Sequence, { initial: { shelf: SHELF } }));
  assert.match(html, /No sequence loaded/);
  assert.strictEqual(count(html, 'class="seq-shelf-item'), 2);
  assert.match(html, /aria-label="Load Warm-up"/);
});

test('a playing sequence shows what plays, where, and the transport, with editing behind Edit', () => {
  given({ sequence: STATUS });
  const html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ, shelf: SHELF, patterns: PATTERNS } }));
  assert.match(html, /class="seq-now"[^>]*aria-live="polite"/);
  assert.match(html, /Friday.*Playing.*Bar 3/s);
  for (const verb of ['Play', 'Pause', 'Stop']) assert.match(html, new RegExp(`aria-label="${verb}"`));
  assert.match(html, /class="seq-edit-toggle" aria-pressed="false"/);
  assert.doesNotMatch(html, /class="seq-inspector"/, 'the inspector waits for Edit');
  const lanes = [...html.matchAll(/class="seq-lane-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(lanes, ['Base', 'Accents', 'Left']);
  assert.match(html, /the last shared lane wins/i);
  assert.strictEqual(count(html, 'class="seq-block'), 2);
  assert.match(html, /class="seq-block[^"]*playing/, 'the clip on top of its lane shows it plays');
});

test('the editor has clip rows, the inspector, command rows, automation and the playlist switch', () => {
  given({ sequence: STATUS });
  const html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ, shelf: SHELF, patterns: PATTERNS, editing: true, selected: 'c2' } }));
  assert.match(html, /class="seq-edit-toggle active" aria-pressed="true"/);
  assert.strictEqual(count(html, 'class="seq-clip-row'), 2);
  assert.match(html, /class="seq-inspector"/);
  for (const label of ['Preset', 'Start beat', 'Length', 'Loop every', 'Targets', 'Mute']) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /value="hd.neon-domino"/);
  assert.match(html, /class="seq-command-row"/);
  assert.match(html, /value="132"/);
  assert.match(html, /aria-label="Tempo automation mode"/);
  assert.match(html, /aria-label="Brightness automation mode"/);
  assert.match(html, /period in beats/);
  assert.match(html, /period in seconds/);
  assert.match(html, /role="switch" aria-checked="false"[^>]*>[^<]*Playlist/);
  assert.match(html, /Add a track for/);
  for (const verb of ['Save', 'Duplicate', 'Delete']) assert.match(html, new RegExp(`>${verb}<`));
});

test('the pattern library inserts at the playhead in one tap and captures a range', () => {
  given({ sequence: STATUS });
  const html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ, patterns: PATTERNS, editing: true } }));
  assert.match(html, /aria-label="Insert Four on the floor at beat 9"/);
  assert.match(html, /Capture beats/);
});

test('record controls: count-in, overdub or replace, quantise; keep or discard while a take runs', () => {
  given({ sequence: STATUS });
  let html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ } }));
  assert.match(html, /aria-label="Count-in beats"/);
  assert.match(html, /aria-label="Record mode"/);
  assert.match(html, />Overdub<.*>Replace</s);
  assert.match(html, /aria-label="Quantise"/);
  assert.match(html, /aria-label="Record"/);
  assert.doesNotMatch(html, />Keep take</);
  given({ sequence: { ...STATUS, recording: { mode: 'overdub', fromBeat: 12, quantise: 1, hits: 0 } } });
  html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ } }));
  assert.match(html, />Keep take<.*>Discard</s);
});

test('the record state is the live status: no `recording` key, no take, whatever the page did', () => {
  given({ sequence: STATUS });
  const html = ui.html(ui.h(ui.Sequence, { initial: { sequence: SEQ, recording: true } }));
  assert.doesNotMatch(html, />Keep take</, 'a refused stop leaves the take running, a lapsed one ends it: the server says which');
  assert.match(html, /aria-label="Record"/);
});

test('a sequence edit the server refuses is replaced by the sequence the server has', async () => {
  const calls = [];
  const shown = [];
  const request = async (url, init) => {
    calls.push([url, init && init.method]);
    if (init && init.method === 'PUT') return { ok: false, error: 'clips.0.lengthBeats: too small' };
    return { ok: true, sequence: SEQ, status: STATUS };
  };
  const edited = { ...SEQ, name: 'Refused' };
  await ui.putSequence(request, edited, (s) => shown.push(s));
  assert.deepStrictEqual(calls, [['/api/sequence', 'PUT'], ['/api/sequence', undefined]]);
  assert.deepStrictEqual(shown, [edited, SEQ]);
});

test('a sequence edit the server takes stays as sent', async () => {
  const shown = [];
  const request = async () => ({ ok: true, sequence: SEQ, status: STATUS });
  await ui.putSequence(request, SEQ, (s) => shown.push(s));
  assert.deepStrictEqual(shown, [SEQ]);
});

test('automation starts inside the server\'s ranges: tempo 20–300 BPM, the master 0–255, a whole period of 1–512', () => {
  const tempo = ui.automationStart('tempo', 'sine');
  const brightness = ui.automationStart('brightness', 'target');
  for (const [a, lo, hi] of [[tempo, 20, 300], [brightness, 0, 255]]) {
    assert.ok(a.min >= lo && a.max <= hi && a.min <= a.max, JSON.stringify(a));
    assert.ok(Number.isInteger(a.period) && a.period >= 1 && a.period <= 512);
  }
  assert.ok(Number.isFinite(brightness.target), 'target mode carries a target');
  assert.strictEqual(tempo.target, undefined);
});

test('the automation editor steps whole periods and shows a target only in target mode', () => {
  given({ sequence: STATUS });
  const seq = { ...SEQ, automation: { tempo: { mode: 'target', period: 4, min: 120, max: 130, growing: true, target: 128 }, brightness: SEQ.automation.brightness } };
  const html = ui.html(ui.h(ui.Sequence, { initial: { sequence: seq, editing: true } }));
  assert.doesNotMatch(html, /step="0.5"[^>]*min="0.5"/);
  assert.strictEqual(count(html, '<span>target</span>'), 1, 'the tempo in target mode, not the brightness in sine');
});

test('a new clip plays a preset: the selected clip\'s, else the last clip\'s, else the first in the library', () => {
  const at = { laneId: 'a', startBeat: 4, beatsPerBar: 4 };
  assert.strictEqual(ui.newClip(SEQ, { ...at, selected: 'c2', library: [{ id: 'x.lib' }] }).presetId, 'hd.neon-domino');
  assert.strictEqual(ui.newClip(SEQ, { ...at, library: [{ id: 'x.lib' }] }).presetId, 'hd.neon-domino');
  assert.strictEqual(ui.newClip({ ...SEQ, clips: [] }, { ...at, library: [{ id: 'x.lib' }] }).presetId, 'x.lib');
  assert.strictEqual(ui.newClip({ ...SEQ, clips: [] }, { ...at, library: [] }), null, 'no preset to play, no clip');
});

// The server refuses a clip holding a legacy row or a strobe (400), and play
// answers 409 while a clip is a rapid flash before the acknowledgement.
const CLIP_LIBRARY = [
  { id: 'hd.old-chase', legacy: true },
  { id: 'hd.strobe', spec: { kind: 'strobe' } },
  { id: 'ldj.visualizer.firework', spec: { kind: 'ldj.visualizer' } },
  { id: 'hd.glow', spec: { kind: 'glow' } },
];
const CLIP_ROWS = [{ id: 'hd.strobe', rapidFlash: true }, { id: 'ldj.visualizer.firework', rapidFlash: true }, { id: 'hd.glow', rapidFlash: false }];

test('a new clip from the library skips a legacy row, a strobe, and a rapid flash before the acknowledgement', () => {
  const at = { laneId: 'a', startBeat: 4, beatsPerBar: 4 };
  const empty = { ...SEQ, clips: [] };
  assert.strictEqual(ui.newClip(empty, { ...at, library: CLIP_LIBRARY, rows: CLIP_ROWS }).presetId, 'hd.glow');
  assert.strictEqual(ui.newClip(empty, { ...at, library: CLIP_LIBRARY, rows: CLIP_ROWS, acknowledged: true }).presetId, 'ldj.visualizer.firework');
  assert.strictEqual(ui.newClip(empty, { ...at, library: CLIP_LIBRARY.slice(0, 3), rows: CLIP_ROWS }), null, 'nothing that plays, no clip');
});

test('Add clip reads the live preset rows and acknowledgement: only rapid flashes unacknowledged, no clip to add', (t) => {
  t.after(() => { ui.librarySig.value = { ...ui.librarySig.value, builtin: [] }; });
  ui.librarySig.value = { ...ui.librarySig.value, builtin: CLIP_LIBRARY.slice(0, 3) };
  const view = () => ui.html(ui.h(ui.Sequence, { initial: { sequence: { ...SEQ, clips: [] }, shelf: SHELF, patterns: PATTERNS, editing: true } }));
  given({ sequence: STATUS, patterns: CLIP_ROWS, safety: { photosensitivityAcknowledged: false } });
  assert.match(view(), /<button type="button" disabled title="No preset to play yet">Add clip</);
  given({ sequence: STATUS, patterns: CLIP_ROWS, safety: { photosensitivityAcknowledged: true } });
  assert.match(view(), /<button type="button">Add clip</);
});

test('a command changed to another type takes a value of that type', () => {
  const k = { id: 'k1', atBeat: 16, type: 'tempo', value: 132 };
  assert.strictEqual(ui.commandAs(k, 'brightness').value, 255);
  assert.strictEqual(ui.commandAs(k, 'goto').value, 0);
  assert.strictEqual(ui.commandAs(k, 'palette', ['party']).value, 'party');
  assert.strictEqual(ui.commandAs({ ...k, type: 'brightness', value: 255 }, 'tempo').value, 128);
});

test('a typed field keeps its text while focused, whatever the live state redraws, and commits once on blur or Enter', () => {
  const d = ui.createTextDraft();
  const committed = [];
  assert.strictEqual(d.shown(8), '8');
  d.focus(8);
  d.input('1');
  assert.strictEqual(d.shown(8), '1');
  d.input('12.');
  assert.strictEqual(d.shown(9.5), '12.', 'a beat tick does not rewrite the text being typed');
  d.commit(ui.parseNumber, (v) => committed.push(v));
  assert.deepStrictEqual(committed, [12]);
  assert.strictEqual(d.shown(12), '12');
  d.commit(ui.parseNumber, (v) => committed.push(v));
  assert.deepStrictEqual(committed, [12], 'a blur after Enter commits nothing new');
  d.focus(12);
  d.input('');
  d.commit(ui.parseNumber, (v) => committed.push(v));
  assert.deepStrictEqual(committed, [12], 'an empty field is not 0: the stored value comes back');
});

test('the board shows the colours it plays held, as the server spells them (upper case)', () => {
  given({ matrix: { mode: 'cycle', colours: ['#FF0000', '#FFFFFF'], voice: 'v1' } });
  const html = ui.html(ui.h(ui.Matrix, {}));
  assert.match(html, /class="matrix-cell held"[^>]*aria-label="Colour #ff0000"/);
  assert.match(html, /class="matrix-cell held"[^>]*aria-label="Colour #ffffff"/);
  assert.strictEqual(count(html, 'class="matrix-cell held"'), 2);
});

test('before the board state arrives no mode is shown as chosen', () => {
  given({});
  const html = ui.html(ui.h(ui.Matrix, {}));
  assert.doesNotMatch(html, /aria-checked="true"/);
});

test('a press the server refuses (409 before the acknowledgement, 400 past eight cells) stops renewing and lets the finger go', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  const refused = [];
  const holds = ui.createMatrixHolds((verb, body, action) => {
    posted.push([verb, body, action]);
    return action === 'press' ? Promise.resolve({ ok: false, error: 'acknowledgement required' }) : true;
  }, (pointerId) => refused.push(pointerId));
  holds.press(7, '#ff0000');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(refused, [7]);
  t.mock.timers.tick(900);
  assert.strictEqual(posted.length, 1, 'no renewal, and no release for a cell the server never held');
  holds.releaseAll();
  assert.strictEqual(posted.length, 1);
});

test('a press the server takes keeps renewing under its token', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  const refused = [];
  const holds = ui.createMatrixHolds((verb, body, action) => {
    posted.push([verb, body, action]);
    return action === 'press' ? Promise.resolve({ ok: true, mode: 'cycle', colours: ['#FF0000'], voice: 'v1' }) : true;
  }, (pointerId) => refused.push(pointerId));
  holds.press(1, '#ff0000');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(300);
  assert.deepStrictEqual(refused, []);
  assert.deepStrictEqual(posted.map(([v, b, a]) => [v, a, b.token]), [['press', 'press', posted[0][1].token], ['press', 'renew', posted[0][1].token]]);
  holds.releaseAll();
});

test('the Matrix board is a grid of colours with the five board modes', () => {
  given({ matrix: { mode: 'flashes', colours: ['#FF0000'], voice: 'v1' } });
  const html = ui.html(ui.h(ui.Matrix, {}));
  assert.deepStrictEqual(ui.MATRIX_MODES.map((m) => m.id), ['fireworks', 'flashes', 'pulses', 'cycle', 'solid']);
  assert.match(html, /role="radiogroup" aria-label="Board mode"/);
  assert.match(html, /role="radio" aria-checked="true"[^>]*>Flashes</);
  assert.ok(count(html, 'class="matrix-cell') >= 12);
  assert.match(html, /class="matrix-cell held"[^>]*aria-label="Colour #ff0000"/, 'a colour the board plays shows held');
  assert.match(html, /touch-action: none|touch-action:none/);
});

test('matrix holds: each finger presses with its own token, renews, and releases its colour', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const posted = [];
  const holds = ui.createMatrixHolds((verb, body) => { posted.push([verb, body]); return true; });
  holds.press(1, '#ff0000');
  holds.press(2, '#0000ff');
  assert.strictEqual(posted.length, 2);
  assert.notStrictEqual(posted[0][1].token, posted[1][1].token);
  t.mock.timers.tick(300);
  assert.deepStrictEqual(posted.slice(2).map(([v, b]) => [v, b.colour]), [['press', '#ff0000'], ['press', '#0000ff']], 'a renewal presses again');
  holds.release(1);
  assert.deepStrictEqual(posted.at(-1), ['release', { colour: '#ff0000', token: posted[0][1].token }]);
  holds.releaseAll();
  assert.deepStrictEqual(posted.at(-1)[0], 'release');
  assert.strictEqual(posted.at(-1)[1].colour, '#0000ff');
});
