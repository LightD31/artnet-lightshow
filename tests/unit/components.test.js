// The live page's components, rendered in Node: bundled by esbuild as the
// page is (JSX, the shared .ts modules), with socket.io-client swapped for a
// socket that never connects, and drawn to HTML by preact-render-to-string
// from a state snapshot. What they draw from a given state is pinned here;
// how they behave in a browser is tests/e2e.

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
        export { Perform, sourceHealth } from './public-src/components/Perform.jsx';
        export { CommandBar } from './public-src/components/CommandBar.jsx';
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'components-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const EFFECTS = [
  { id: 'white-strobe', name: 'White Strobe' }, { id: 'color-strobe', name: 'Colour Strobe' },
  { id: 'blinder', name: 'Blinder' }, { id: 'uv-wash', name: 'UV Wash' }, { id: 'kill', name: 'Kill' }, { id: 'glow', name: 'Glow' },
];

function given(state) {
  ui.store.applySnapshot({ versions: {}, state: {
    bpm: 124.5, beatDivision: 2, running: true, masterDimmer: 128, masterBlackout: false,
    energyEffects: EFFECTS, energyOverride: null, clock: { source: 'tap', bpm: 124.5 },
    palettes: [{ id: 'arctic', name: 'Arctic', colors: { 4: [1, 2, 3, 4] } }, { id: 'volcanic', name: 'Volcanic', colors: { 4: [5, 6, 7, 8] } }],
    palette: 'volcanic', colorPresets: [], activeSource: 'timer',
    autoShow: { status: 'idle', intensity: 70 },
    ...state,
  } });
}
const count = (html, needle) => html.split(needle).length - 1;

test('the Perform view has a pad for blackout, every effect, and tap — in the order a hand learns them', () => {
  given({});
  const html = ui.html(ui.h(ui.Perform, {}));
  const names = [...html.matchAll(/class="perform-pad-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Blackout', 'Kill', 'Blinder', 'Strobe', 'Colour strobe', 'UV', 'Glow', 'Tap']);
  assert.strictEqual(count(html, 'aria-pressed="true"'), 1, 'only the palette in use is pressed');
  assert.match(html, /class="perform-palette active" aria-pressed="true"><span[^>]*>.*?Volcanic/);
  assert.match(html, /aria-valuetext="50 percent"/, 'the master, as a person reads it');
  assert.match(html, /aria-valuetext="70 percent"/, 'the show\'s intensity');
  assert.match(html, /Nothing loaded/);
});

test('blackout and a held effect show as pressed', () => {
  given({ masterBlackout: true, energyOverride: 'uv-wash' });
  const html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /class="perform-pad pad-blackout active" aria-pressed="true"/);
  assert.match(html, /class="perform-pad pad-uv-wash active"/);
  assert.match(html, /on — tap to restore/);
});

test('sync health says when the source the show follows is not working', () => {
  const { sourceHealth } = ui;
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: true } }), 'ok');
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: true, stale: true } }), 'warn');
  assert.strictEqual(sourceHealth({ activeSource: 'prolink', prolink: { connected: false } }), 'off');
  assert.strictEqual(sourceHealth({ activeSource: 'spotify', spotify: { authenticated: false } }), 'off');
  assert.strictEqual(sourceHealth({ activeSource: 'hybrid', hybrid: { driver: 'spotify' } }), 'warn');
  assert.strictEqual(sourceHealth({ activeSource: 'timer' }), 'none');

  given({ activeSource: 'prolink', prolink: { connected: false }, autoShow: { status: 'idle', error: { message: 'no beats', at: 1 } } });
  const html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /chip-off.*?PRO DJ LINK.*?\(not working\)/s);
  assert.match(html, /chip-warn" title="no beats"/, 'a failed analysis is flagged, with why');
});

test('the command bar offers every division to 1/16, a tempo to type, and a named master', () => {
  given({});
  const html = ui.html(ui.h(ui.CommandBar, {}));
  const divisions = [...html.matchAll(/title="Beat division 1\/(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(divisions, [1, 2, 4, 8, 16]);
  assert.match(html, /aria-label="Tempo 124.5 BPM. Press to type a tempo."/);
  assert.match(html, /aria-label="Master dimmer" aria-valuetext="50 percent"/);
  assert.match(html, /<section class="command-bar" aria-label="Live controls">/);
});
