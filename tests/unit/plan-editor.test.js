// The Rig view's plot: which edge is which, the lamps still to place, and the
// auto-place proposal.

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
        export { rigSelectionSig } from './public-src/rig-ui.js';
        export { pointIn, autoPlace, PLAN_SNAP } from './public-src/stage-geometry.js';
        export { PlanEditor } from './public-src/components/setup/PlanEditor.jsx';
        export { buildRig } from './src/shared/rig.ts';
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-editor-')), 'bundle.mjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  return import(file);
}

const ui = await load();

const PAR = { id: 'par', name: 'Par', channelCount: 4, channelMap: { dimmer: 0, red: 1, green: 2, blue: 3 } };
const PROFILES = { par: PAR };
const fixture = (id, extra = {}) => ({ id, label: `Lamp ${id}`, address: id * 4 - 3, universe: 0, profileId: 'par', ...extra });

function render(fixtures, selected = []) {
  ui.store.applySnapshot({ versions: {}, state: { profiles: PROFILES, fixtures } });
  ui.rigSelectionSig.value = selected;
  return ui.html(ui.h(ui.PlanEditor, {}));
}

test('the plot keeps the back of the stage at the top and the audience at the bottom, as the patterns read it', () => {
  const out = render([fixture(1)]);
  assert.match(out, /<span class="stage-back">BACK OF STAGE<\/span>/);
  assert.match(out, /<span class="stage-audience">AUDIENCE<\/span>/);
  assert.match(out, /aria-label="Plan of the rig, viewed from above with the audience at the bottom"/);
  // The StagePlan the party patterns travel by: down the plot, 0 at the back and 1 at the front.
  const fixtures = [fixture(1, { position: { x: 20, y: 10 } }), fixture(2, { position: { x: 80, y: 90 } })];
  const rig = ui.buildRig(fixtures, (f) => PROFILES[f.profileId]);
  const { plan, order } = rig.layout(null, 'stage').fixtures;
  const at = (id) => order.indexOf(fixtures.findIndex((f) => f.id === id));
  assert.ok(plan.y[at(1)] < plan.y[at(2)], 'a lamp near the top edge is further back than one by the audience');
});

test('unplaced lamps are listed beside the plot as chips; placed ones are not', () => {
  const out = render([fixture(1, { position: { x: 20, y: 30 } }), fixture(2), fixture(3)]);
  const chips = out.match(/<button[^>]*class="plan-chip[^"]*"[^>]*>/g) || [];
  assert.equal(chips.length, 2);
  assert.match(out, /aria-label="Not placed yet: 2 lamps"/);
  assert.match(out, /data-chip="2"[^>]*aria-pressed="false"[^>]*title="Tap, then tap the plot to place Lamp 2 \(or drag it there\)"/);
  assert.match(out, /<span class="plan-chip-n">3<\/span>Lamp 3/);
  assert.doesNotMatch(out, /data-chip="1"/);
  assert.match(out, /<button[^>]*class="btn sm plan-auto"[^>]*>Auto-place 2<\/button>/);
});

test('with everything placed the chips say so and Auto-place offers all', () => {
  const out = render([fixture(1, { position: { x: 20, y: 30 } })]);
  assert.match(out, /Every lamp is placed\./);
  assert.match(out, /<button[^>]*class="btn sm plan-auto"[^>]*>Auto-place all<\/button>/);
});

test('auto-place spreads the unplaced lamps by group in patch order and leaves placed ones alone', () => {
  const fixtures = [
    fixture(1, { position: { x: 5, y: 5 } }),
    fixture(2, { group: 'back' }),
    fixture(3),
    fixture(4, { group: 'front' }),
    fixture(5),
    fixture(6, { group: 'front' }),
  ];
  const proposal = ui.autoPlace(fixtures);
  assert.deepEqual(proposal.map((p) => p.id), [2, 3, 4, 5, 6], 'never the placed lamp');
  const at = Object.fromEntries(proposal.map((p) => [p.id, p.position]));
  // Rows back (the top edge), ungrouped, front (the audience edge).
  assert.ok(at[2].y < at[3].y && at[3].y < at[4].y);
  assert.equal(at[4].y, at[6].y);
  assert.equal(at[3].y, at[5].y);
  assert.ok(at[4].x < at[6].x && at[3].x < at[5].x, 'patch order runs left to right within a row');
  assert.equal(at[2].x, 50, 'a row of one stands in the middle');
  for (const p of proposal) {
    assert.equal(p.position.x % ui.PLAN_SNAP, 0);
    assert.equal(p.position.y % ui.PLAN_SNAP, 0);
    assert.ok(p.position.x > 0 && p.position.x < 100 && p.position.y > 0 && p.position.y < 100);
  }
});

test('auto-place "all" re-spreads every lamp', () => {
  const fixtures = [fixture(1, { position: { x: 5, y: 5 } }), fixture(2)];
  const proposal = ui.autoPlace(fixtures, { all: true });
  assert.deepEqual(proposal.map((p) => p.id), [1, 2]);
  assert.deepEqual(Object.keys(proposal[0].position).sort(), ['x', 'y']);
  assert.deepEqual(ui.autoPlace([fixture(1, { position: { x: 1, y: 1 } })]), [], 'nothing unplaced, nothing proposed');
});

test('auto-place keeps a grid step clear of placed lamps and of its own proposals, opening another row when one is full', () => {
  const near = (a, b) => Math.abs(a.x - b.x) <= ui.PLAN_SNAP && Math.abs(a.y - b.y) <= ui.PLAN_SNAP;
  const one = ui.autoPlace([fixture(1, { position: { x: 50, y: 50 } }), fixture(2)]);
  assert.equal(one.length, 1);
  assert.ok(!near(one[0].position, { x: 50, y: 50 }), 'not on the placed lamp');
  assert.equal(one[0].position.y, 50, 'shifted along its row');
  const row = Array.from({ length: 37 }, (_, k) => fixture(k + 1, { position: { x: 5 + 2.5 * k, y: 50 } }));
  const full = ui.autoPlace([...row, fixture(40), fixture(41)]);
  for (const p of full) for (const q of [...row.map((f) => ({ position: f.position })), ...full.filter((o) => o !== p)]) assert.ok(!near(p.position, q.position));
  assert.notEqual(full[0].position.y, 50, 'a full row opens the next');
});
