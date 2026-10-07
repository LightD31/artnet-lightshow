// The live page's components, rendered in Node: bundled by esbuild as the
// page is (JSX, the shared .ts modules), with socket.io-client swapped for a
// socket that never connects, and drawn to HTML by preact-render-to-string
// from a state snapshot. What they draw from a given state is pinned here;
// how they behave in a browser is tests/e2e.

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
        export { render as html } from 'preact-render-to-string';
        export { h } from 'preact';
        export { store } from './public-src/state.js';
        export { Perform, sourceHealth } from './public-src/components/Perform.jsx';
        export { Header } from './public-src/components/Header.jsx';
        export { CommandBar } from './public-src/components/CommandBar.jsx';
        export { Effects, PhotosensitivityConfirm, editingSig, filterByLibrary, groupRows, quickDeck, tapRow, usePress } from './public-src/components/Effects.jsx';
        export { Inspector, readRecommendedPreference, savePreset, withRecommended } from './public-src/components/Inspector.jsx';
        export { PaletteEditor, isHexColour, normaliseHex, savePalette } from './public-src/components/PaletteEditor.jsx';
        export { librarySig, socket } from './public-src/state.js';
        export { Pads, PadEditor, padGlyph, padBody, contentRows } from './public-src/components/Pads.jsx';
        export { StrobePad, StrobeSettings, strobeBody } from './public-src/components/StrobePad.jsx';
        export { createVoiceHolds } from './public-src/hold-control.js';
        export { BUILTIN_PALETTES, CATALOGUE, FAMILIES } from './src/shared/effects/index.ts';
        export { requiresAcknowledgement } from './src/shared/effects/registry.ts';
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
    pads: { layout: LAYOUT, lit: Array(16).fill(null) }, voices: [], strobe: STROBE,
    ...state,
  } });
}
const count = (html, needle) => html.split(needle).length - 1;

// The pads layout as the server sends it: bank 0 the energy effects, the strobe and a look.
const pad = (bank, slot, label, content, launch = 'hold', extra = {}) => ({
  bank, slot, label, accent: '#FF8800', content, launch, quantise: 0.25, targets: 'shared', ...extra,
});
const LAYOUT = [
  pad(0, 0, 'Kill', { kind: 'preset', id: 'energy.kill' }),
  pad(0, 1, 'Blinder', { kind: 'preset', id: 'energy.blinder' }),
  pad(0, 2, 'Strobe', { kind: 'strobe', id: 'strobe' }),
  pad(0, 3, 'Colour strobe', { kind: 'preset', id: 'energy.colorStrobe' }),
  pad(0, 4, 'UV', { kind: 'preset', id: 'energy.uvWash' }, 'loop'),
  pad(0, 5, 'Glow', { kind: 'preset', id: 'energy.glow' }, 'once'),
  pad(0, 6, 'Domino', { kind: 'preset', id: 'hd.neonDomino' }, 'loop', { targets: [2] }),
  pad(0, 7, '', null),
  ...Array.from({ length: 8 }, (_, i) => pad(1, i, `Look ${i + 1}`, { kind: 'pattern', id: 'chase' }, 'loop')),
];
const STROBE = {
  active: null, mode: null,
  settings: { palette: ['#FFFFFF'], flashesPerSecond: 5, continueBetween: false, clock: 'wall', brightness: 1, onMs: 100, blackMs: 100 },
};
const padLabels = (html) => [...html.matchAll(/class="pad-label">([^<]*)</g)].map((m) => m[1]);

test('the Perform view has blackout, the pads of the bank, the strobe and tap', () => {
  given({});
  const html = ui.html(ui.h(ui.Perform, {}));
  const names = [...html.matchAll(/class="perform-pad-name">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Blackout', 'Tap']);
  assert.deepStrictEqual(padLabels(html), ['Kill', 'Blinder', 'Strobe', 'Colour strobe', 'UV', 'Glow', 'Domino', 'Empty']);
  assert.match(html, /class="strobe-hold"/);
  assert.strictEqual(count(html, 'aria-pressed="true"'), 2, 'only the palette in use and the override\'s Off are pressed');
  assert.match(html, /aria-pressed="true" data-override="off"/, 'no palette override: Off is pressed');
  assert.match(html, /class="perform-palette active" aria-pressed="true"><span[^>]*>.*?Volcanic/);
  assert.match(html, /aria-valuetext="50 percent"/, 'the master, as a person reads it');
  assert.match(html, /aria-valuetext="70 percent"/, 'the show\'s intensity');
  assert.match(html, /Nothing loaded/);
  assert.doesNotMatch(html, /Latch effects/, 'a pad\'s launch mode says how it plays');
});

test('the Perform view has the outputs switch, saying what disarmed means', () => {
  given({ armed: false });
  let html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /class="perform-arm-switch" role="switch" aria-checked="false"/);
  assert.match(html, /Disarmed.*nothing goes out to the rig — tap to arm/s);
  given({ armed: true });
  html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /class="perform-arm-switch armed" role="switch" aria-checked="true"/);
  assert.match(html, /Armed.*frames go out to the rig — tap to disarm/s);
});

test('until the acknowledgement, the header and Perform say the strobes are off, one tap from the warning; acknowledged, or before the server has said, nothing', () => {
  const views = () => [ui.html(ui.h(ui.Header, {})), ui.html(ui.h(ui.Perform, {}))];
  const notice = /<button type="button" class="[^"]*" data-safety="ask"[^>]*>(?:<[^>]+>)*Strobes off until acknowledged/;
  given({ safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.match(html, notice);
  assert.match(views()[1], /tap to acknowledge/);
  given({ safety: { photosensitivityAcknowledged: true, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 } });
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
  given({});
  for (const html of views()) assert.doesNotMatch(html, /Strobes off/);
});

test('blackout and a running voice\'s pad show as pressed', () => {
  const lit = Array(16).fill(null);
  lit[4] = 'v7';
  given({ masterBlackout: true, pads: { layout: LAYOUT, lit } });
  const html = ui.html(ui.h(ui.Perform, {}));
  assert.match(html, /class="perform-pad pad-blackout active" aria-pressed="true"/);
  assert.match(html, /class="pad-cell lit"[^>]*data-slot="4"[^>]*aria-pressed="true"/);
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

// ── The Effects view, its inspector and the palette editor ─────────────────

// The catalogue rows as the server lists them in `patterns` (src/server/presets.ts).
const PRESET_ROWS = ui.CATALOGUE.filter((p) => !p.legacy).map((p) => ({
  id: p.id, name: p.name, desc: p.desc, ...(p.party ? { party: true } : {}), ...(p.pixel ? { pixel: true } : {}),
  app: p.app, family: p.family, rapidFlash: ui.requiresAcknowledgement(p.spec), scope: p.spec.scope ?? null,
}));
const LEGACY_ROWS = ui.CATALOGUE.filter((p) => p.legacy).map(({ id, name, desc, party }) => ({ id, name, desc, party }));
const UPSTREAM_ROWS = [
  { id: 'chase', name: 'Chase →', desc: 'One fixture at a time, forward' },
  { id: 'gradient', name: 'Gradient', desc: 'The look\'s colours as a gradient scrolling across the rig', pixel: true },
];
const PATTERN_ROWS = [...UPSTREAM_ROWS, ...LEGACY_ROWS, ...PRESET_ROWS];
const domino = ui.CATALOGUE.find((p) => p.id === 'hd.neonDomino');
const USER_PRESET = {
  id: 'u1', name: 'My Domino', spec: { ...domino.spec, params: { ...domino.spec.params, attack: 0.5 } },
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
};
const USER_PALETTE = { id: 'p1', name: 'Mine', colours: ['#112233', '#445566'] };

function givenLibrary(state) {
  ui.librarySig.value = {
    status: 'ready', families: ui.FAMILIES, builtin: ui.CATALOGUE, user: [USER_PRESET],
    palettes: { builtin: ui.BUILTIN_PALETTES, user: [USER_PALETTE] },
  };
  given({
    pattern: 'hd.neonDomino', patterns: PATTERN_ROWS, families: ui.FAMILIES, builtinPalettes: ui.BUILTIN_PALETTES,
    effects: [{ id: 'u1', name: 'My Domino', kind: 'hd.positionChase', rapidFlash: false, scope: 'measure', updatedAt: USER_PRESET.updatedAt }],
    userPalettes: [USER_PALETTE], safety: { photosensitivityAcknowledged: false, hdFlashIntervalMs: 350, strobeMaxLatchSec: 60 },
    fixtures: [{ id: 1, name: 'Par 1' }, { id: 2, name: 'Par 2' }], profiles: {},
    ...state,
  });
}

/** The button for one row of the list, as rendered. */
const rowOf = (html, id) => {
  const m = new RegExp(`<button[^>]*data-id="${id.replace(/\./g, '\\.')}"[^>]*>(?:(?!</button>).)*</button>`, 's').exec(html);
  return m ? m[0] : null;
};

test('the Effects view lists Hue Dynamics and Light DJ by family, then the fork\'s own and the upstream patterns', () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  const groups = [...html.matchAll(/class="effects-group-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(groups, ['Hue Dynamics', 'Light DJ', 'Own', 'Upstream patterns']);
  // A family heads its presets.
  assert.match(html, /Position Chase<\/[^>]+>(?:(?!effects-family-title).)*data-id="hd\.neonDomino"/s);
  assert.match(html, /effects-family-title">Disco<\/[^>]+>(?:(?!effects-family-title).)*data-id="hd\.disco\.pop"/s);
  assert.match(html, /effects-family-title">Channel<\/[^>]+>(?:(?!effects-family-title).)*data-id="ldj\.StrobeCycle"/s);
  // The fork's own: the presets saved here, the party looks, the energy controls.
  assert.match(html, /effects-family-title">Your presets<\/[^>]+>(?:(?!effects-family-title).)*data-id="u1"/s);
  assert.match(html, /effects-family-title">Party Looks<\/[^>]+>(?:(?!effects-family-title).)*data-id="position-chase"/s);
  assert.match(html, /effects-family-title">Energy<\/[^>]+>(?:(?!effects-family-title).)*data-id="energy\.blinder"/s);
  assert.ok(rowOf(html, 'chase') && rowOf(html, 'gradient'), 'the upstream patterns are listed');
  // The one playing is pressed, and only it.
  assert.strictEqual(count(html, 'aria-pressed="true"'), 1 + 1, 'the row on stage, and the Library chip All');
  assert.match(rowOf(html, 'hd.neonDomino'), /class="pattern-btn active/);
  // Every group is folded until opened; a search opens them.
  assert.strictEqual(count(html, '<details class="effects-group" open'), 0);
  assert.strictEqual(count(html, '<details class="effects-group"'), 4);
  // A rapid flash carries its warning; a slow one does not.
  assert.match(rowOf(html, 'hd.voltageConfetti'), /badge-rapid/);
  assert.match(rowOf(html, 'ldj.TrueStrobe'), /badge-rapid/);
  assert.doesNotMatch(rowOf(html, 'hd.neonDomino'), /badge-rapid/);
  assert.match(html, /type="search"[^>]*aria-label="Search effects"/);
});

test('the Library filter: Single is the one-beat presets, Multi the measure ones, Custom the saved ones, All everything', () => {
  const rows = [
    { id: 'a', scope: 'singleBeat' }, { id: 'b', scope: 'measure' }, { id: 'u', scope: 'measure', user: true }, { id: 'c' },
  ];
  const ids = (mode) => ui.filterByLibrary(rows, mode).map((r) => r.id);
  assert.deepStrictEqual(ids('single'), ['a']);
  assert.deepStrictEqual(ids('multi'), ['b', 'u']);
  assert.deepStrictEqual(ids('custom'), ['u']);
  assert.deepStrictEqual(ids('all'), ['a', 'b', 'u', 'c']);
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  const labels = [...html.matchAll(/class="effects-chip library[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((m) => `${m[2]}:${m[1]}`);
  assert.deepStrictEqual(labels, ['Single:false', 'Multi:false', 'Custom:false', 'All:true']);
  const chips = [...html.matchAll(/class="effects-chip ?[^"]*"[^>]*aria-pressed="false"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(chips.slice(0, 3), ['Party', 'Pixel', 'Rapid flash'], 'the filters are chips');
  // Grouping keeps the server's family order and puts the saved presets first among the fork's own.
  const grouped = ui.groupRows([{ id: 'u1', name: 'Mine', user: true, scope: 'measure' }, ...PATTERN_ROWS], ui.FAMILIES);
  assert.deepStrictEqual(grouped.map((g) => g.app), ['hd', 'ldj', 'own', 'upstream']);
  assert.deepStrictEqual(grouped[2].families.map((f) => f.name), ['Your presets', 'Party Looks', 'Energy']);
  assert.deepStrictEqual(grouped[3].families.map((f) => f.name), ['Patterns', 'Pixel effects']);
});

test('the inspector offers only what the family can use, with beats read out in ticks', () => {
  givenLibrary({});
  // Position Chase: staggered, ordered, on an angle — no trail, probability or origin.
  let html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
  assert.match(html, /Neon Domino/);
  for (const label of ['Curve', 'Attack', 'Hold', 'Release', 'Stagger', 'Direction', 'Order', 'Angle', 'Repetitions', 'Loop length', 'Trigger']) {
    assert.match(html, new RegExp(`>${label}<`), `${label} is offered`);
  }
  for (const label of ['Trail', 'Probability', 'Radius', 'Origin x']) {
    assert.doesNotMatch(html, new RegExp(`>${label}<`), `${label} is not`);
  }
  assert.match(html, /80 ticks/, 'the attack, 80/960 of a beat');
  assert.match(html, /default 4 beats/, 'a measure preset loops over the bar unless told otherwise');
  assert.match(html, /Save as…/);
  assert.doesNotMatch(html, />Delete</, 'a built-in cannot be deleted');
  // Radial Pulse: an origin and a radius, no angle, stagger or order.
  html = ui.html(ui.h(ui.Inspector, { id: 'hd.bassBloom' }));
  for (const label of ['Origin x', 'Origin y', 'Origin z', 'Radius', 'Direction']) assert.match(html, new RegExp(`>${label}<`), label);
  for (const label of ['Angle', 'Stagger', 'Order', 'Trail']) assert.doesNotMatch(html, new RegExp(`>${label}<`), label);
  // Simple ADSR: the per-channel envelope instead of the attack, hold and release.
  html = ui.html(ui.h(ui.Inspector, { id: 'hd.iceStrike' }));
  assert.match(html, />Envelope</);
  assert.doesNotMatch(html, />Attack</);
  assert.match(html, /default 1 beat</, 'a single-beat preset loops once a beat');
  // A Light DJ row: its cadence and length, and Backlit where the row has a backlit twin.
  html = ui.html(ui.h(ui.Inspector, { id: 'ldj.StrobeCycle' }));
  assert.match(html, />Cadence</);
  assert.match(html, />Beats</);
  assert.match(html, />Backlit</);
  html = ui.html(ui.h(ui.Inspector, { id: 'ldj.Swirl' }));
  assert.doesNotMatch(html, />Backlit</);
  // The Visualizer and the Disco.
  html = ui.html(ui.h(ui.Inspector, { id: 'ldj.visualizer.firework' }));
  for (const label of ['Active', 'Mellow', 'Auto colours']) assert.match(html, new RegExp(`>${label}<`), label);
  html = ui.html(ui.h(ui.Inspector, { id: 'hd.disco.pop' }));
  for (const label of ['Style', 'Channels', 'Bands', 'Globals', 'Par 1', 'Par 2']) assert.match(html, new RegExp(`>${label}<`), label);
  // A preset of your own saves in place and can go.
  html = ui.html(ui.h(ui.Inspector, { id: 'u1' }));
  assert.match(html, /My Domino/);
  assert.match(html, /480 ticks/, 'its own attack');
  assert.match(html, />Save</);
  assert.match(html, />Delete</);
});

test('the palette editor takes hex colours and Light DJ\'s Random, and flags what is neither', () => {
  assert.ok(ui.isHexColour('#abc') && ui.isHexColour('#AABBCC') && ui.isHexColour('#aabbccdd'));
  assert.ok(!ui.isHexColour('AABBCC') && !ui.isHexColour('#GGGGGG') && !ui.isHexColour('#AABBCCD') && !ui.isHexColour(''));
  assert.strictEqual(ui.normaliseHex('#abc'), '#AABBCC');
  assert.strictEqual(ui.normaliseHex('#aabbccdd'), '#AABBCCDD');
  const html = ui.html(ui.h(ui.PaletteEditor, {
    colours: ['#FF0000', 'nope', { random: true }], onChange: () => {}, builtin: ui.BUILTIN_PALETTES, user: [USER_PALETTE],
  }));
  assert.match(html, /aria-label="Colour 1"[^>]*value="#FF0000"/);
  assert.doesNotMatch(html, /aria-label="Colour 1"[^>]*aria-invalid/);
  assert.match(html, /aria-label="Colour 2"[^>]*aria-invalid="true"/);
  assert.match(html, /class="palette-random"[^>]*>Random</);
  assert.match(html, /<optgroup label="Light DJ">(?:(?!<\/optgroup>).)*>Red Cyan</s);
  assert.match(html, /<optgroup label="Your palettes">(?:(?!<\/optgroup>).)*>Mine</s);
  assert.match(html, /Save as palette…/);
  // Eight is the most; a full palette offers no ninth.
  const full = ui.html(ui.h(ui.PaletteEditor, { colours: Array(8).fill('#FFFFFF'), onChange: () => {} }));
  assert.doesNotMatch(full, />\+ Colour</);
});

test('saving a built-in posts a copy; saving a preset of your own puts it in place', async () => {
  givenLibrary({});
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    const body = JSON.parse(init.body);
    const preset = { id: path === '/api/effects' ? 'u2' : path.split('/').pop(), name: body.name, spec: body.spec, createdAt: 'now', updatedAt: 'now' };
    const palette = { id: 'p2', name: body.name, colours: body.colours };
    return { ok: true, status: 201, json: async () => ({ ok: true, ...(body.spec ? { preset } : { palette }) }) };
  };
  try {
    const draft = { name: 'Slow Domino', spec: { ...domino.spec, params: { ...domino.spec.params, attack: 0.5 } } };
    const copy = await ui.savePreset({ source: 'builtin', id: 'hd.neonDomino' }, draft);
    assert.strictEqual(copy.ok, true);
    assert.strictEqual(copy.preset.id, 'u2');
    assert.deepStrictEqual([calls[0].path, calls[0].init.method], ['/api/effects', 'POST']);
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), draft);
    assert.ok(ui.librarySig.value.user.some((p) => p.id === 'u2'), 'the copy is in the library at once');

    await ui.savePreset({ source: 'user', id: 'u1' }, { name: 'My Domino', spec: USER_PRESET.spec });
    assert.deepStrictEqual([calls[1].path, calls[1].init.method], ['/api/effects/u1', 'PUT']);

    const saved = await ui.savePalette('Sunset', ['#FF8800', { random: true }]);
    assert.strictEqual(saved.palette.id, 'p2');
    assert.deepStrictEqual([calls[2].path, calls[2].init.method], ['/api/palettes', 'POST']);
    assert.deepStrictEqual(JSON.parse(calls[2].init.body), { name: 'Sunset', colours: ['#FF8800', { random: true }] });
    assert.ok(ui.librarySig.value.palettes.user.some((p) => p.id === 'p2'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the photosensitivity confirm names the risk and asks before a rapid flash plays', () => {
  const row = PRESET_ROWS.find((r) => r.id === 'hd.voltageConfetti');
  const html = ui.html(ui.h(ui.PhotosensitivityConfirm, { preset: row, onConfirm: () => {}, onCancel: () => {} }));
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-labelledby="photosensitivity-title"/);
  assert.match(html, /Voltage Confetti/);
  assert.match(html, /photosensitive epilepsy/i);
  assert.match(html, />I understand — play it</);
  assert.match(html, />Cancel</);
});

/** The deck's pads, in order, as rendered. */
const deckOf = (html) => {
  const deck = /<div class="effects-deck"[^>]*>(.*?)<div class="effects-catalogue">/s.exec(html);
  return deck ? [...deck[1].matchAll(/<div class="effect-pad ?[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]) : null;
};

test('the deck comes first: the presets saved here and the party looks as big pads, the app on each, the one on stage marked', () => {
  givenLibrary({ pattern: 'position-chase' });
  const html = ui.html(ui.h(ui.Effects, {}));
  assert.ok(html.indexOf('class="effects-deck"') < html.indexOf('class="effects-catalogue"'), 'the deck is above the catalogue');
  const deck = deckOf(html);
  assert.deepStrictEqual(deck.slice(0, 2), ['u1', 'position-chase'], 'the saved preset, then the party looks in catalogue order');
  assert.ok(deck.includes('swirl') && !deck.includes('hd.neonDomino') && !deck.includes('chase'), 'party looks only, no built-in or upstream row');
  // The badge names the app; a preset saved here carries its kind's app and says it is yours.
  assert.match(html, /data-id="u1">(?:(?!<\/div>).)*effect-pad-app">Hue Dynamics<span class="effect-pad-yours"> · Yours</s);
  assert.match(html, /data-id="position-chase">(?:(?!<\/div>).)*effect-pad-app">Own</s);
  assert.match(html, /<div class="effect-pad active" data-id="position-chase">(?:(?!<\/div>).)*effect-pad-now">Now playing</s);
  assert.strictEqual(count(html, 'effect-pad-now">Now playing<'), 1);
  // Every pad and row has its pencil; the pencil is not the pad.
  assert.match(html, /<button type="button" class="effect-edit" aria-label="Edit My Domino"/);
  assert.match(html, /<button type="button" class="effect-edit" aria-label="Edit Neon Domino"/);
});

test('what is playing stays in sight above the search, even when its group is folded', () => {
  givenLibrary({});
  const html = ui.html(ui.h(ui.Effects, {}));
  const bar = /<div class="effects-now" role="status"[^>]*>(.*?)<\/div>/s.exec(html);
  assert.ok(bar, 'the now-playing bar is there');
  assert.match(bar[1], /effects-now-name">Neon Domino</);
  assert.match(bar[1], /effects-now-app">Hue Dynamics</);
  assert.match(bar[1], /aria-label="Edit Neon Domino"/, 'its own pencil');
  assert.ok(html.indexOf('class="effects-now"') < html.indexOf('class="effects-search"'), 'above the search');
  assert.ok(html.indexOf('class="effects-tools"') < html.indexOf('class="effects-now"'), 'inside the sticky tools');
  assert.strictEqual(count(html, '<details class="effects-group" open'), 0, 'while every group is folded');
  givenLibrary({ pattern: null });
  assert.doesNotMatch(ui.html(ui.h(ui.Effects, {})), /class="effects-now"/, 'nothing playing, no bar');
});

test('a favourite is pinned first on the deck, whatever it is', () => {
  const rows = [{ id: 'a', party: true }, { id: 'u', user: true }, { id: 'x', app: 'ldj' }, { id: 'b', party: true }];
  assert.deepStrictEqual(ui.quickDeck(rows, []).map((r) => r.id), ['u', 'a', 'b']);
  assert.deepStrictEqual(ui.quickDeck(rows, ['x', 'b']).map((r) => r.id), ['x', 'b', 'u', 'a']);
  assert.deepStrictEqual(ui.quickDeck(rows, ['gone']).map((r) => r.id), ['u', 'a', 'b'], 'a favourite that no longer exists is skipped');
  givenLibrary({});
  globalThis.localStorage = { getItem: (key) => (key === 'lightshow.effects.favourites' ? JSON.stringify(['ldj.Swirl', 'u1']) : null), setItem() {}, removeItem() {} };
  try {
    const html = ui.html(ui.h(ui.Effects, {}));
    assert.deepStrictEqual(deckOf(html).slice(0, 3), ['ldj.Swirl', 'u1', 'position-chase']);
    assert.match(html, /class="effect-star on" aria-pressed="true" aria-label="Favourite Swirl"/);
    assert.match(html, /class="effect-star " aria-pressed="false" aria-label="Favourite Neon Domino"/);
  } finally {
    delete globalThis.localStorage;
  }
});

test('a row press: a long press opens the editor once and is not a tap; a quick tap is a tap', () => {
  const calls = { tap: 0, long: 0 };
  let press = null;
  const Probe = () => { press = ui.usePress(() => { calls.tap += 1; }, () => { calls.long += 1; }); return null; };
  ui.html(ui.h(Probe, {}));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    press.onPointerDown();
    mock.timers.tick(600);
    press.onPointerUp();
    press.onClick();
    assert.deepStrictEqual(calls, { tap: 0, long: 1 }, 'the long press, and the click after it swallowed');
    press.onPointerDown();
    mock.timers.tick(100);
    press.onPointerUp();
    press.onClick();
    mock.timers.tick(1000);
    assert.deepStrictEqual(calls, { tap: 1, long: 1 }, 'a quick tap');
  } finally {
    mock.timers.reset();
  }
});

test('a plain tap puts the row on stage and nothing else', () => {
  const sent = ui.socket.sent;
  ui.socket.connected = true;
  try {
    sent.length = 0;
    assert.strictEqual(ui.tapRow({ id: 'hd.neonDomino', name: 'Neon Domino', rapidFlash: false }, false), true);
    assert.deepStrictEqual(sent, [['set', { pattern: 'hd.neonDomino' }]]);
    // A rapid flash before the acknowledgement asks, and sends nothing.
    sent.length = 0;
    const asked = [];
    assert.strictEqual(ui.tapRow({ id: 'hd.voltageConfetti', rapidFlash: true }, false, (row) => asked.push(row.id)), false);
    assert.deepStrictEqual([sent, asked], [[], ['hd.voltageConfetti']]);
    // Acknowledged, it plays like any other.
    assert.strictEqual(ui.tapRow({ id: 'hd.voltageConfetti', rapidFlash: true }, true), true);
    assert.deepStrictEqual(sent, [['set', { pattern: 'hd.voltageConfetti' }]]);
  } finally {
    ui.socket.connected = false;
    sent.length = 0;
  }
});

test('the inspector stays hidden until Edit is chosen, and closes again', () => {
  givenLibrary({});
  ui.editingSig.value = null;
  let html = ui.html(ui.h(ui.Effects, {}));
  assert.strictEqual(count(html, 'class="card effect-inspector"'), 0);
  assert.strictEqual(count(html, 'role="dialog"'), 0);
  ui.editingSig.value = 'hd.neonDomino';
  try {
    html = ui.html(ui.h(ui.Effects, {}));
    assert.strictEqual(count(html, 'class="card effect-inspector"'), 1);
    assert.match(html, /class="effect-sheet" role="dialog" aria-modal="true"[^>]*><div class="card effect-inspector">/, 'in a sheet over the page');
    assert.match(html, /class="card effect-inspector">(?:(?!<\/strong>).)*<strong>Neon Domino</s);
    assert.match(html, /aria-label="Close the inspector"/);
  } finally {
    ui.editingSig.value = null;
  }
});

test('a family change asks, applies or keeps, as chosen once and kept in this browser', () => {
  givenLibrary({});
  const stored = {};
  globalThis.localStorage = { getItem: (key) => stored[key] ?? null, setItem: (key, v) => { stored[key] = v; }, removeItem() {} };
  try {
    assert.strictEqual(ui.readRecommendedPreference(), 'ask', 'asks until told otherwise');
    let html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
    assert.match(html, />On a family change</);
    assert.match(html, /<option selected value="ask">Ask</);
    stored['lightshow.effects.recommended'] = 'keep';
    assert.strictEqual(ui.readRecommendedPreference(), 'keep');
    html = ui.html(ui.h(ui.Inspector, { id: 'hd.neonDomino' }));
    assert.match(html, /<option selected value="keep">Keep mine</, 'the kept answer can be changed back');
    stored['lightshow.effects.recommended'] = 'bogus';
    assert.strictEqual(ui.readRecommendedPreference(), 'ask', 'anything else is Ask');
  } finally {
    delete globalThis.localStorage;
  }
  // Apply recommended: the family's params and the output settings that travel with them, the name untouched.
  const def = ui.FAMILIES.flatMap((f) => f.kinds).find((k) => k.defaults && k.defaults.params);
  const before = { name: 'x', kind: 'hd.other', params: { stale: 1 }, brightness: 0.1 };
  const after = ui.withRecommended(before, def);
  assert.strictEqual(after.kind, def.kind);
  assert.deepStrictEqual(after.params, def.defaults.params);
  assert.strictEqual(after.name, 'x');
  assert.strictEqual(after.brightness, def.defaults.brightness ?? 0.1);
  assert.notStrictEqual(after.params, def.defaults.params, 'a copy, so editing it leaves the catalogue alone');
});

// ── Perform: pads and the strobe ─────────────────────────────────────────────

test('a pad shows its label, accent and launch glyph; bank tabs switch the eight shown', () => {
  given({});
  const html = ui.html(ui.h(ui.Pads, {}));
  assert.match(html, /role="tablist" aria-label="Pad banks"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>A</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>B</);
  assert.match(html, /style="--pad-accent:#FF8800;?"[^>]*data-bank="0" data-slot="1"/);
  assert.deepStrictEqual([ui.padGlyph('hold'), ui.padGlyph('once'), ui.padGlyph('loop')], ['●', '▶', '↻']);
  assert.match(html, /data-slot="4"[^>]*title="UV — tap to loop, tap again to stop"/);
  assert.match(html, /data-slot="5"[^>]*title="Glow — tap to play once"/);
  assert.match(html, /data-slot="1"[^>]*title="Blinder — hold"/);
  assert.match(html, /class="pad-cell empty"[^>]*disabled/);
  assert.match(html, /aria-pressed="false"[^>]*>Edit pads</);
  const bank1 = ui.html(ui.h(ui.Pads, { initialBank: 1 }));
  assert.deepStrictEqual(padLabels(bank1), ['Look 1', 'Look 2', 'Look 3', 'Look 4', 'Look 5', 'Look 6', 'Look 7', 'Look 8']);
});

test('the pad editor offers favourites, saved and party presets first, launch, quantise and fixtures', () => {
  givenLibrary({ pads: { layout: LAYOUT, lit: Array(16).fill(null) } });
  const rows = ui.contentRows([{ id: 'u1', name: 'My Domino', user: true }, ...PATTERN_ROWS], ['chase']);
  assert.deepStrictEqual(rows.slice(0, 2).map((r) => r.id), ['chase', 'u1']);
  assert.ok(rows.findIndex((r) => !r.party && !r.user && r.id !== 'chase') > rows.findIndex((r) => r.party), 'party before the rest');
  const html = ui.html(ui.h(ui.PadEditor, { entry: LAYOUT[6], onClose: () => {} }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Edit pad A7"/);
  assert.match(html, /<option value="preset:hd.neonDomino" selected/);
  assert.match(html, /<option value="preset:u1"/);
  assert.match(html, /<option value="pattern:chase"/);
  assert.match(html, /name="pad-launch" value="loop" checked/);
  assert.match(html, /<option value="0.25" selected>1\/4 beat</);
  assert.match(html, /<input type="checkbox" value="2" checked[^>]*\/?>(?:<span>)?Par 2/);
  assert.match(html, /<input type="checkbox" value="1"(?! checked)[^>]*\/?>(?:<span>)?Par 1/);
});

test('the pad editor sends the fields the server stores; the strobe pad stays held', () => {
  const body = ui.padBody({ label: 'Domino', accent: '#00ff00', content: 'preset:hd.neonDomino', launch: 'loop', quantise: '1', targets: [2, 1] });
  assert.deepStrictEqual(body, { label: 'Domino', accent: '#00FF00', content: { kind: 'preset', id: 'hd.neonDomino' }, launch: 'loop', quantise: 1, targets: [2, 1] });
  assert.deepStrictEqual(ui.padBody({ label: '', accent: '#123456', content: 'strobe:strobe', launch: 'loop', quantise: 0, targets: 'shared' }).launch, 'hold');
  assert.strictEqual(ui.padBody({ label: '', accent: '#123456', content: '', launch: 'once', quantise: 0, targets: [] }).content, null);
  assert.strictEqual(ui.padBody({ label: '', accent: '#123456', content: '', launch: 'once', quantise: 0, targets: [] }).targets, 'shared', 'no fixture ticked is the whole rig');
});

test('the strobe pad holds, says when it runs, and offers a 2 s burst and its settings', () => {
  given({});
  let html = ui.html(ui.h(ui.StrobePad, {}));
  assert.match(html, /class="strobe-hold"[^>]*aria-pressed="false"/);
  assert.match(html, />Burst 2 s</);
  assert.match(html, /aria-label="Strobe settings"/);
  given({ strobe: { ...STROBE, active: { id: 'strobe', mode: 'hold', startedAt: 1, until: null }, mode: 'hold' } });
  html = ui.html(ui.h(ui.StrobePad, {}));
  assert.match(html, /class="strobe-hold active"[^>]*aria-pressed="true"/);
});

test('the strobe settings sheet: palette of up to six, flashes per second, continue, clock, brightness', () => {
  givenLibrary({ strobe: STROBE });
  const html = ui.html(ui.h(ui.StrobeSettings, { onClose: () => {} }));
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Strobe settings"/);
  assert.match(html, /value="#FFFFFF"/, 'the palette editor with the strobe\'s colour');
  assert.match(html, /aria-label="Flashes per second"[^>]*min="1"[^>]*max="5"[^>]*value="5"/);
  assert.match(html, /<input type="checkbox"[^>]*\/?>(?:<span>)?Look shows between flashes/);
  assert.match(html, /<option value="wall" selected/);
  assert.match(html, /aria-label="Strobe brightness"[^>]*value="100"/);
  assert.deepStrictEqual(ui.strobeBody({ palette: ['#ff0000', 'random', '#00FF00', '#1', '#2', '#3', '#444444', '#555555', '#666666', '#777777'], flashesPerSecond: '3', continueBetween: true, clock: 'beat', brightness: 50 }),
    { palette: ['#FF0000', '#00FF00', '#444444', '#555555', '#666666', '#777777'], flashesPerSecond: 3, continueBetween: true, clock: 'beat', brightness: 0.5 });
});

test('voice holds: each pad its own token, a release names its pad, all let go at once', () => {
  const sent = [];
  const holds = ui.createVoiceHolds((p) => { sent.push(p); return true; });
  holds.press('p0-1', { pad: { bank: 0, slot: 1 } });
  holds.press('strobe', { effect: { preset: 'strobe' } });
  assert.notStrictEqual(sent[0].token, sent[1].token);
  assert.deepStrictEqual(sent[0], { action: 'press', token: sent[0].token, pad: { bank: 0, slot: 1 } });
  assert.deepStrictEqual(sent[1], { action: 'press', token: sent[1].token, effect: { preset: 'strobe' } });
  assert.deepStrictEqual(holds.held(), ['p0-1', 'strobe']);
  holds.release('p0-1');
  assert.deepStrictEqual(sent[2], { action: 'release', token: sent[0].token, pad: { bank: 0, slot: 1 } });
  holds.releaseAll();
  assert.deepStrictEqual(sent[3], { action: 'release', token: sent[1].token, effect: { preset: 'strobe' } });
  assert.deepStrictEqual(holds.held(), []);
});

test('the command bar\'s strip is pads bank A', () => {
  given({});
  const html = ui.html(ui.h(ui.CommandBar, {}));
  assert.match(html, /class="cb-energy-label">PADS</);
  const names = [...html.matchAll(/class="cb-energy-name">([^<]*)</g)].map((m) => m[1]);
  assert.deepStrictEqual(names, ['Kill', 'Blinder', 'Strobe', 'Colour strobe', 'UV', 'Glow', 'Domino']);
});
