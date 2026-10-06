// Fixes from the Effects view review: long press, focus trap, palette sync, Cadence.
import test, { mock } from 'node:test';
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
        export { h } from 'preact';
        export { default as html } from 'preact-render-to-string';
        export { createPress, usePress } from './public-src/components/Effects.jsx';
        export { trapKey, trapFocusIn } from './public-src/focus-trap.js';
        export { sameColours } from './public-src/components/PaletteEditor.jsx';
        export { showsCadence } from './public-src/components/Inspector.jsx';
        export { LONG_PRESS_MS } from './public-src/voice-pad.js';
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'effects-fixes-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

function press() {
  const calls = { tap: 0, long: 0 };
  const p = ui.createPress({ onTap: () => { calls.tap += 1; }, onLongPress: () => { calls.long += 1; } });
  return { calls, ...p };
}

test('a long press whose row is gone before it fires opens nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { calls, handlers, stop } = press();
    handlers.onPointerDown();
    mock.timers.tick(ui.LONG_PRESS_MS - 100);
    stop(); // what the row's unmount runs
    mock.timers.tick(1000);
    assert.deepStrictEqual(calls, { tap: 0, long: 0 });
  } finally {
    mock.timers.reset();
  }
});

test('a long press fires once and swallows the click after it; a tap is a tap', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { calls, handlers } = press();
    handlers.onPointerDown();
    mock.timers.tick(ui.LONG_PRESS_MS + 1);
    handlers.onPointerUp();
    handlers.onClick();
    assert.deepStrictEqual(calls, { tap: 0, long: 1 });
    handlers.onPointerDown();
    mock.timers.tick(100);
    handlers.onPointerUp();
    handlers.onClick();
    mock.timers.tick(1000);
    assert.deepStrictEqual(calls, { tap: 1, long: 1 });
  } finally {
    mock.timers.reset();
  }
});

// A sheet with two buttons; `doc.activeElement` is what has focus.
function sheet(doc) {
  const a = { focus() { doc.activeElement = a; }, getClientRects: () => [1] };
  const b = { focus() { doc.activeElement = b; }, getClientRects: () => [1] };
  const box = {
    contains: (el) => el === box || el === a || el === b,
    querySelectorAll: () => [a, b],
    focus() { doc.activeElement = box; },
  };
  return { a, b, box };
}

const key = (k, shiftKey = false) => {
  const e = { key: k, shiftKey, prevented: false, stopped: false };
  e.preventDefault = () => { e.prevented = true; };
  e.stopPropagation = () => { e.stopped = true; };
  return e;
};

test('with focus fallen to the page, Escape still closes the sheet', () => {
  const doc = { body: {}, activeElement: null };
  doc.activeElement = doc.body;
  const { box } = sheet(doc);
  let closed = 0;
  ui.trapKey(key('Escape'), box, () => { closed += 1; }, doc);
  assert.strictEqual(closed, 1);
});

test('with focus fallen to the page, Tab and Shift+Tab land back in the sheet', () => {
  const doc = { body: {}, activeElement: null };
  const { a, b, box } = sheet(doc);
  doc.activeElement = doc.body;
  const tab = key('Tab');
  ui.trapKey(tab, box, () => {}, doc);
  assert.strictEqual(doc.activeElement, a);
  assert.ok(tab.prevented);
  doc.activeElement = doc.body;
  ui.trapKey(key('Tab', true), box, () => {}, doc);
  assert.strictEqual(doc.activeElement, b);
});

test('focus that walks out of the sheet is put back in it; focus inside is left alone', () => {
  const doc = { body: {}, activeElement: null };
  const { a, b, box } = sheet(doc);
  const outside = { focus() { doc.activeElement = outside; } };
  doc.activeElement = outside;
  ui.trapFocusIn({ target: outside }, box);
  assert.strictEqual(doc.activeElement, a);
  doc.activeElement = b;
  ui.trapFocusIn({ target: b }, box);
  assert.strictEqual(doc.activeElement, b);
});

test('a palette echoed back by its owner is the same palette; a revert is not', () => {
  assert.ok(ui.sameColours(['#ff0000', { random: true }], ['#FF0000', { random: true }]));
  assert.ok(ui.sameColours(['#f00'], ['#FF0000']));
  assert.ok(!ui.sameColours(['#FF0000', '#00FF00'], ['#FF0000', '#0000FF']));
  assert.ok(!ui.sameColours(['#FF0000'], ['#FF0000', '#FF0000']));
  assert.ok(!ui.sameColours([{ random: true }], ['#FFFFFF']));
});

const FAMILIES = [{
  id: 'ldjStrobe', app: 'ldj', name: 'Strobe', kinds: [
    { kind: 'ldj.TrueStrobe', defaults: { params: { cadence: 1, beats: 32 } }, capabilities: null, wallClock: true },
    { kind: 'ldj.QuickFlash', defaults: { params: { cadence: 4, beats: 4 } }, capabilities: null },
  ],
}];

test('Cadence is offered only where the row steps on the beat', () => {
  assert.strictEqual(ui.showsCadence({ kind: 'ldj.TrueStrobe', params: { cadence: 1 } }, FAMILIES), false, 'a wall-clock row');
  assert.strictEqual(ui.showsCadence({ kind: 'ldj.QuickFlash', params: { cadence: 4 } }, FAMILIES), true, 'a musical row');
  assert.strictEqual(ui.showsCadence({ kind: 'ldj.Unknown', params: { cadence: 1 } }, FAMILIES), true, 'a kind the catalogue does not list');
});
