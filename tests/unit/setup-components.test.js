// The setup views' components, rendered in Node as tests/unit/components.test.js
// renders the live page's: what a settings section, the patch table, the
// inspector and the pre-show report draw from a given state, and the plan's
// geometry — drawing a bar from end to end, lining fixtures up.

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
        export { store } from './public-src/state.js';
        export { settingsSig } from './public-src/setup-state.js';
        export { rigSelectionSig } from './public-src/rig-ui.js';
        export { lineFromEnds, geometryOf } from './public-src/stage-geometry.js';
        export { SettingsSection } from './public-src/components/setup/Section.jsx';
        export { SERVER, ENGINE, LIVE } from './public-src/components/setup/specs.js';
        export { PatchTable, conflictsOf } from './public-src/components/setup/PatchTable.jsx';
        export { Inspector } from './public-src/components/setup/Inspector.jsx';
        export { rowPositions, endToEnd } from './public-src/components/setup/PlanEditor.jsx';
        export { PreflightReport } from './public-src/components/setup/PreflightView.jsx';
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-components-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const PAR = { id: 'par', name: 'Par', manufacturer: 'Test', modeName: '12ch', channelCount: 12, channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const BAR = {
  id: 'bar', name: 'Bar', manufacturer: 'Test', modeName: '8 cells', channelCount: 24, channelMap: {},
  cells: Array.from({ length: 8 }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 } })),
};
const STRIP = {
  id: 'strip', name: 'Strip', channelCount: 900, channelMap: {},
  cells: Array.from({ length: 300 }, (_, c) => ({ channelMap: { red: 3 * c, green: 3 * c + 1, blue: 3 * c + 2 } })),
};
const PROFILES = { par: PAR, bar: BAR, strip: STRIP };
const fixture = (id, address, universe, profileId, extra = {}) => ({ id, label: `F${id}`, address, universe, profileId, ...extra });

function given(state) {
  ui.store.applySnapshot({ versions: {}, state: { profiles: PROFILES, fixtures: [], ...state } });
}

test('a settings section: secrets never shown, restart badges, and what the server resolved', () => {
  ui.settingsSig.value = {
    settings: { server: { host: '127.0.0.1', port: 3000, token: '', publicUrl: '' }, engine: { thread: 'worker' } },
    secrets: { 'server.token': true },
    restartKeys: ['server.host', 'server.port', 'server.token', 'engine.thread'],
    pendingRestart: ['server.port'],
    engine: { thread: 'worker', rate: 44, frames: 100, renderMs: { p95: 0.4 }, lateFrames: 1, skippedFrames: 0 },
  };
  const server = ui.html(ui.h(ui.SettingsSection, ui.SERVER));
  assert.match(server, /id="set-server.token" type="password"/);
  assert.match(server, /placeholder="•••••••• \(leave blank to keep\)"/, 'says a token is set, never what it is');
  assert.doesNotMatch(server, /value="[^"]+" aria-describedby="set-server.token-help"/);
  assert.strictEqual(server.split('class="setting-badge ').length - 1, 3, 'host, port and token restart');
  assert.match(server, /restart to apply/, 'the port differs from what is running');
  assert.match(server, /class="btn active" disabled>Apply/, 'nothing to apply yet');

  const engine = ui.html(ui.h(ui.SettingsSection, ui.ENGINE));
  assert.match(engine, /Currently: its own thread — 44 frames a second, 0.4 ms to render \(p95\), 1 late or dropped/);
});

test('a select keeps a stored value the list no longer has, and says so', () => {
  ui.settingsSig.value = { settings: { live: { enabled: true, source: 'input', device: 'Scarlett 2i2', autoSync: true, director: true, latencyMs: 0 } }, secrets: {} };
  const html = ui.html(ui.h(ui.SettingsSection, { ...ui.LIVE, ctx: { liveDevices: { outputs: ['Speakers'], inputs: ['Line In'] } } }));
  assert.match(html, /Scarlett 2i2 \(not found\)/);
  assert.match(html, /The default input/, 'the input list, for an input');
  assert.doesNotMatch(html, /Speakers/);
});

test('overlaps: on one universe only, and a strip on every universe it runs over', () => {
  const clash = ui.conflictsOf([fixture(1, 1, 0, 'par'), fixture(2, 10, 0, 'par'), fixture(3, 10, 1, 'par')], PROFILES);
  assert.deepStrictEqual([...clash].sort(), [1, 2]);
  // 300 pixels: 170 on its first universe, the other 130 (to channel 390) on the next.
  const strip = ui.conflictsOf([fixture(1, 1, 0, 'strip'), fixture(2, 379, 1, 'par'), fixture(3, 391, 1, 'par'), fixture(4, 1, 2, 'par')], PROFILES);
  assert.deepStrictEqual([...strip].sort(), [1, 2], 'the strip runs on over universe 1, to channel 390, and no further');
});

test('the patch table numbers the rig, marks overlaps, and shows a strip\'s end', () => {
  given({ fixtures: [fixture(1, 1, 0, 'par'), fixture(2, 5, 0, 'par'), fixture(3, 1, 3, 'strip')], identify: { ids: [3], remainingMs: 1000 } });
  ui.rigSelectionSig.value = [2];
  const html = ui.html(ui.h(ui.PatchTable, {}));
  assert.strictEqual(html.split('Overlaps another fixture').length - 1, 2);
  assert.match(html, /2 overlapping/);
  assert.match(html, /1–390 on 4/, 'the strip ends on the universe after');
  assert.match(html, /900 \(300 cells\)/);
  assert.match(html, /<tr class="selected /);
  assert.match(html, /class=" identifying"/);
  assert.match(html, /aria-label="Identify F1"/);
});

test('the inspector: one fixture in full, a bar with its line', () => {
  given({ fixtures: [fixture(1, 1, 0, 'par'), fixture(2, 13, 0, 'bar', { position: { x: 40, y: 20 }, geometry: { length: 30, angle: 180 } })] });
  ui.rigSelectionSig.value = [2];
  const html = ui.html(ui.h(ui.Inspector, {}));
  assert.match(html, /Fixture 2/);
  assert.match(html, /id="insp-length"[^>]*value="30"|value="30"[^>]*id="insp-length"/);
  assert.match(html, /id="insp-angle"[^>]*value="180"|value="180"[^>]*id="insp-angle"/);
  assert.match(html, /Reverse/);
  ui.rigSelectionSig.value = [1, 2];
  assert.match(ui.html(ui.h(ui.Inspector, {})), /2 fixtures/);
  ui.rigSelectionSig.value = [];
  assert.match(ui.html(ui.h(ui.Inspector, {})), /Select a fixture/);
});

test('a bar drawn from its first cell to its last', () => {
  const across = ui.lineFromEnds({ x: 20, y: 30 }, { x: 80, y: 30 }, 8);
  assert.deepStrictEqual(across.position, { x: 50, y: 30 });
  // The end cells sit half a cell in from the bar's ends.
  assert.strictEqual(across.geometry.length, Math.round((60 * 8 / 7) * 10) / 10);
  assert.strictEqual(across.geometry.angle, 0);
  assert.strictEqual(ui.lineFromEnds({ x: 80, y: 30 }, { x: 20, y: 30 }, 8).geometry.angle, 180, 'drawn backwards, it runs backwards');
  assert.strictEqual(ui.lineFromEnds({ x: 50, y: 10 }, { x: 50, y: 60 }, 4).geometry.angle, 90, 'towards the audience');
  assert.strictEqual(ui.lineFromEnds({ x: 0, y: 0 }, { x: 100, y: 100 }, 2).geometry.length, 100, 'no longer than the server takes');
  assert.deepStrictEqual(ui.geometryOf(10, 270), { length: 10, angle: -90 });
});

test('arranging: a row in the order they stand, bars end to end', () => {
  const row = ui.rowPositions([{ x: 70, y: 20 }, { x: 10, y: 40 }, { x: 30, y: 60 }]);
  assert.deepStrictEqual(row, [{ x: 70, y: 40 }, { x: 10, y: 40 }, { x: 40, y: 40 }]);
  assert.deepStrictEqual(ui.rowPositions([{ x: 50, y: 10 }, { x: 50, y: 30 }]).map((p) => p.x), [10, 90], 'stacked ones are spread');

  const chain = ui.endToEnd([{ length: 20, centre: { x: 40, y: 10 } }, { length: 20, centre: { x: 60, y: 30 } }]);
  assert.deepStrictEqual(chain.map((c) => c.position), [{ x: 40, y: 20 }, { x: 60, y: 20 }]);
  assert.ok(chain.every((c) => c.geometry.angle === 0));
  const long = ui.endToEnd(Array.from({ length: 5 }, () => ({ length: 40, centre: { x: 50, y: 50 } })));
  const total = long.reduce((sum, c) => sum + c.geometry.length, 0);
  assert.ok(total <= 96.5, `shortened to fit: ${total}`);
});

test('the pre-show report says what to fix, and each row in words', () => {
  const report = {
    ok: false, counts: { ok: 3, warn: 1, fail: 1, info: 0 },
    checks: [
      { status: 'ok', label: 'Art-Net', detail: 'Two nodes answered', fix: 'n/a' },
      { status: 'fail', label: 'Analyser', detail: 'Python cannot import librosa', fix: 'pip install -r requirements.txt' },
      { status: 'warn', label: 'Spotify', detail: 'Not connected', fix: 'Connect it under Sources' },
    ],
  };
  const html = ui.html(ui.h(ui.PreflightReport, { report }));
  assert.match(html, /Not ready — 1 problem to fix\./);
  assert.match(html, /<span class="sr-only">Problem: <\/span>/);
  assert.match(html, /pip install -r requirements.txt/);
  assert.doesNotMatch(html, /n\/a/, 'no fix for what passed');
  const ready = ui.html(ui.h(ui.PreflightReport, { report: { ok: true, counts: { ok: 4, warn: 0, fail: 0 }, checks: [] } }));
  assert.match(ready, /Ready\. 4 checks passed\./);
});
