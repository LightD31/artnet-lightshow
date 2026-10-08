import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..', '..');
const result = await esbuild.build({
  stdin: { contents: `export { hardwareFitRows } from './public-src/components/HardwareFit.jsx';`, resolveDir: ROOT },
  bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', jsxImportSource: 'preact',
  alias: { 'socket.io-client': path.join(ROOT, 'tests/helpers/fake-socket-io.js') }, logLevel: 'silent',
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hardware-fit-'));
const file = path.join(directory, 'bundle.mjs');
fs.writeFileSync(file, result.outputFiles[0].text);
const { hardwareFitRows } = await import(file);
fs.rmSync(directory, { recursive: true, force: true });

const FAST = { kind: 'hd.pulse', params: { cadence: .125 } };
const SLOW = { kind: 'energy.glow', params: {} };
const MACRO = { kind: 'macro', params: { loopBeats: 8, steps: [{ beats: 4, effect: SLOW }, { beats: 4, effect: FAST }] } };
const state = (more = {}) => ({
  bpm: 120, running: false, hardware: { technologies: {}, products: {} },
  fixtures: [1, 2].map((id) => ({ id, label: `Lamp ${id}`, hardware: { maxFlashHz: 2, minTransitionMs: 0 } })),
  ...more,
});
const table = (spec = FAST) => ({ revision: 1,
  lanes: [{ id: 'lane', kind: 'shared', name: 'Main', mute: false, solo: false }],
  clips: [{ id: 'clip', laneId: 'lane', fixtureIds: null, startBeat: 0, lengthBeats: 16, loopBeats: 8, spec, seed: [1, 2, 3, 4], mute: false }],
});
const sequence = (beat = 1) => ({ loaded: { id: 'sequence' }, playing: true, paused: false, beat,
  activeClips: [{ id: 'clip', name: 'Current effect' }] });

test('shared voices report adaptation for every fixture', () => {
  const fit = hardwareFitRows(state({ voices: [{ id: 'v', spec: FAST, targets: 'shared' }] }));
  assert.deepEqual(fit.rows.map((row) => [row.key, row.mode]), [['v:1', 'slower'], ['v:2', 'slower']]);
  assert.equal(fit.incomplete, false);
});

test('voice targets restrict hardware checks to their fixtures', () => {
  const fit = hardwareFitRows(state({ voices: [{ id: 'v', spec: FAST, targets: [2] }] }));
  assert.deepEqual(fit.rows.map((row) => row.key), ['v:2']);
});

test('hardware fit uses the followed clock tempo', () => {
  const spec = { ...FAST, params: { cadence: .5 } };
  const fit = hardwareFitRows(state({ bpm: 60, clock: { bpm: 120 }, voices: [{ id: 'v', spec }] }));
  assert.deepEqual(fit.rows.map((row) => row.mode), ['slower', 'slower']);
});

test('hidden voices contribute no hardware adaptation rows', () => {
  const fit = hardwareFitRows(state({ voices: [{ id: 'v', spec: FAST, hidden: true }] }));
  assert.deepEqual(fit.rows, []);
});

test('active sequence clips contribute their fixture adaptation rows', () => {
  const fit = hardwareFitRows(state({ sequence: sequence() }), { table: table() });
  assert.deepEqual(fit.rows.map((row) => [row.key, row.mode]), [['sequence:clip:1', 'slower'], ['sequence:clip:2', 'slower']]);
});

test('sequence lane targeting limits its hardware checks', () => {
  const compiled = table();
  compiled.lanes[0] = { ...compiled.lanes[0], kind: 'track', fixtureId: 2 };
  const fit = hardwareFitRows(state({ sequence: sequence() }), { table: compiled });
  assert.deepEqual(fit.rows.map((row) => row.key), ['sequence:clip:2']);
});

test('a sequence awaiting its table cannot report complete hardware fit', () => {
  assert.equal(hardwareFitRows(state({ sequence: sequence() })).incomplete, true);
});

test('sequence macro admission follows the current clip lap and step', () => {
  const modes = (beat) => hardwareFitRows(state({ sequence: sequence(beat) }), { table: table(MACRO) }).rows.map((row) => row.mode);
  assert.deepEqual(modes(2), ['play', 'play']);
  assert.deepEqual(modes(6), ['slower', 'slower']);
  assert.deepEqual(modes(10), ['play', 'play']);
});

test('a macro without its live launch phase stays explicitly unknown', () => {
  const fit = hardwareFitRows(state({ clock: { beatPos: 6 }, voices: [{ id: 'v', spec: MACRO, targets: 'shared' }] }));
  assert.deepEqual(fit.rows.map((row) => row.mode), ['unknown', 'unknown']);
  assert.equal(fit.incomplete, true);
});

test('paused macro clips do not reuse frozen sequence position as live phase', () => {
  const fit = hardwareFitRows(state({ sequence: { ...sequence(2), playing: false, paused: true } }), { table: table(MACRO) });
  assert.deepEqual(fit.rows.map((row) => row.mode), ['unknown', 'unknown']);
});

test('stopped sequences contribute no active hardware adaptation rows', () => {
  const fit = hardwareFitRows(state({ sequence: { ...sequence(), playing: false, stopped: 'hold' } }), { table: table() });
  assert.deepEqual(fit.rows, []);
});
