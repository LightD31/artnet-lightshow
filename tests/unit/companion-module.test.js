// The Companion module's link to the server: protocol 2 (a snapshot, then only
// what changed), the catalogues it builds its buttons from, momentary holds
// kept alive while a button is down, and the HTTP calls for cues and the auto
// show. Driven against the real socket handlers; the parts of the module that
// need Companion itself are not loaded here.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

import { StateStore } from '../../companion-module/src/store.js';
import { LightshowConnection } from '../../companion-module/src/connection.js';
import * as catalog from '../../companion-module/src/catalog.js';
import { attachSockets } from '../../src/server/sockets.ts';
import { createPublisher } from '../../src/server/protocol.ts';
import { state, getLiveState } from '../../src/server/state.ts';
import { PATTERNS, ENERGY_EFFECTS, COLOR_PRESETS, STROBE_FUNCTIONS, AUTO_SOURCES } from '../../src/server/presets.ts';
import { PIXEL_MAPS } from '../../src/shared/rig.ts';
import { showStore } from '../../src/server/show-store.ts';

showStore.scheduleSave = () => {};

test('the store keeps a snapshot and applies each domain\'s changes in order', () => {
  const store = new StateStore();
  assert.strictEqual(store.applyPatch({ d: 'look', v: 1, set: { bpm: 120 } }), 'gap', 'nothing before a snapshot');
  const keys = store.applySnapshot({ versions: { look: 3, rig: 1 }, state: { bpm: 120, pattern: 'chase', fixtures: [] } });
  assert.deepStrictEqual([...keys].sort(), ['bpm', 'fixtures', 'pattern']);
  assert.deepStrictEqual([...store.applyPatch({ d: 'look', v: 4, set: { bpm: 128 }, del: ['pattern'] })], ['bpm', 'pattern']);
  assert.deepStrictEqual(store.state, { bpm: 128, fixtures: [] });
  assert.strictEqual(store.applyPatch({ d: 'look', v: 4, set: { bpm: 1 } }), 'stale');
  assert.strictEqual(store.applyPatch({ d: 'look', v: 6, set: { bpm: 1 } }), 'gap', 'one was missed');
  assert.strictEqual(store.state.bpm, 128, 'and nothing half-applied');
});

test('its built-in lists are the server\'s, for before it has connected', () => {
  assert.deepStrictEqual(catalog.PATTERNS.map((p) => [p.id, !!p.pixel]), PATTERNS.map((p) => [p.id, !!p.pixel]));
  assert.deepStrictEqual(catalog.ENERGY_EFFECTS.map((e) => e.id), ENERGY_EFFECTS.map((e) => e.id));
  assert.deepStrictEqual(catalog.COLOR_PRESETS.map((c) => c.name), COLOR_PRESETS.map((c) => c.name), 'colours are sent by index');
  assert.deepStrictEqual(catalog.STROBE_FUNCTIONS.map((f) => f.id), STROBE_FUNCTIONS.map((f) => f.id));
  assert.deepStrictEqual(catalog.AUTO_SOURCES.map((s) => s.id).sort(), [...AUTO_SOURCES].sort());
  assert.deepStrictEqual(catalog.PIXEL_MAPS.map((m) => m.id), [...PIXEL_MAPS]);

  const fromServer = { patterns: [{ id: 'new-one', name: 'New One', pixel: true }], palettes: [{ id: 'sunset', name: 'Sunset', colors: { 2: [0, 1] } }] };
  assert.deepStrictEqual(catalog.choices(catalog.patternsOf(fromServer)), [{ id: 'new-one', label: 'New One' }], 'the server\'s own, once it has sent them');
  assert.strictEqual(catalog.patternName({}, 'fire'), 'Fire');
  assert.deepStrictEqual(catalog.paletteSwatch(fromServer, fromServer.palettes[0]).map((c) => c.name), ['Red', 'Amber']);
});

// ── Against the server ───────────────────────────────────────────────────────

test('Companion palettes include unified builtins and saved palettes', () => {
  const live = { palettes: [{ id: 'old' }], builtinPalettes: [{ id: 'all', name: 'All' }],
    userPalettes: [{ id: 'mine', name: 'Mine' }] };
  assert.deepStrictEqual(catalog.palettesOf(live).map((p) => p.id), ['all', 'mine']);
  assert.equal(catalog.paletteName(live, 'mine'), 'Mine');
  assert.ok(['builtinPalettes', 'userPalettes'].every((key) => catalog.CATALOG_KEYS.includes(key)));
});

test('Companion palette swatches retain every full-colour emitter', () => {
  assert.deepStrictEqual(catalog.paletteSwatch({}, { colours: ['#102030405060', '#abc', { random: true }] }), [
    { r: 16, g: 32, b: 48, w: 64, a: 80, uv: 96 }, { r: 170, g: 187, b: 204, w: 0, a: 0, uv: 0 },
  ]);
});

test('Companion colour feedback follows the base body instead of stale indices', () => {
  const live = { colorA: 0, colorB: 0, basePalette: { colours: ['#0000000000FF', '#FF0000'] } };
  assert.equal(catalog.slotColorSelected(live, 'colorA', 0), false);
  assert.equal(catalog.slotColorSelected(live, 'colorB', 0), true);
  assert.equal(catalog.slotColorName(live, 'colorB'), 'Red');
  assert.equal(catalog.slotColorName(live, 'colorC'), catalog.slotColorName(live, 'colorA'));
});

async function serve() {
  const app = express();
  const rest = [];
  app.use(express.json());
  // The HTTP side, as the module calls it: path, method and token.
  app.post(/^\/api\/.*/, (req, res) => {
    rest.push({ path: req.path, token: req.get('x-lightshow-token') });
    if (req.path === '/api/cues/missing/recall') return res.status(404).json({ ok: false, error: 'No such cue' });
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  const io = new Server(server);
  const publisher = createPublisher(io);
  const integrations = { broadcast: () => publisher.publishState(getLiveState()), publisher };
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, rest, integrations,
    async close() { io.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('it connects on protocol 2 and follows the state by its changes alone', async () => {
  const s = await serve();
  const changes = [];
  const statuses = [];
  const conn = new LightshowConnection({
    host: '127.0.0.1', port: s.port, token: 'sesame',
    onStatus: (status) => statuses.push(status), onChange: (keys) => changes.push(keys),
  });
  const before = { pattern: state.pattern, pixelPattern: state.pixelPattern };
  try {
    conn.connect();
    assert.ok(await until(() => conn.state.patterns), 'a snapshot, with the catalogues in it');
    assert.ok(statuses.includes('ok'));
    assert.ok(conn.state.patterns.some((p) => p.id === 'fire' && p.pixel), 'the server\'s own pattern list');
    assert.ok(Array.isArray(conn.state.palettes) && conn.state.palettes.length > 0);

    const seen = changes.length;
    conn.set({ pattern: 'fire', pixelPattern: 'rain' });
    // The server broadcasts on its own clock; here, by hand once it has it.
    assert.ok(await until(() => state.pattern === 'fire'));
    s.integrations.broadcast();
    assert.ok(await until(() => conn.state.pattern === 'fire' && conn.state.pixelPattern === 'rain'));
    const patch = changes.slice(seen).find((keys) => keys.has('pattern'));
    assert.ok(patch && !patch.has('patterns') && !patch.has('fixtures'), `only what changed: ${[...(patch || [])]}`);

    // The auto show and the cues are asked over HTTP, with the token.
    assert.deepStrictEqual(await conn.recallCue('cue 7'), { ok: true });
    const missing = await conn.recallCue('missing');
    assert.equal(missing.ok, false);
    assert.ok(missing.error);
    await conn.autoShow('toggle');
    // The outputs' switch too: a toggle reads the state, which starts disarmed.
    await conn.armOutputs('disarm');
    await conn.armOutputs('toggle');
    assert.deepStrictEqual(s.rest.map((r) => [r.path, r.token]), [
      ['/api/cues/cue%207/recall', 'sesame'], ['/api/cues/missing/recall', 'sesame'], ['/api/auto/start', 'sesame'],
      ['/api/outputs/disarm', 'sesame'], ['/api/outputs/arm', 'sesame'],
    ]);
  } finally {
    conn.disconnect();
    Object.assign(state, before);
    await s.close();
  }
});

test('held Companion effects end on release or disconnect', async () => {
  const s = await serve();
  const conn = new LightshowConnection({ host: '127.0.0.1', port: s.port });
  const other = new LightshowConnection({ host: '127.0.0.1', port: s.port });
  try {
    conn.connect();
    other.connect();
    assert.ok(await until(() => conn.state.patterns && other.state.patterns));
    assert.ok(conn.holdEnergy('blinder'));
    assert.ok(await until(() => other.state.energyOverride === 'blinder'), 'on while held');
    await new Promise((r) => setTimeout(r, 1700));
    assert.strictEqual(state.heldEnergy, 'blinder', 'kept alive past the server\'s 1.2 s timeout');
    conn.releaseEnergy();
    assert.ok(await until(() => other.state.energyOverride == null), 'and off when let go');

    conn.holdEnergy('kill');
    assert.ok(await until(() => state.heldEnergy === 'kill'));
    conn.disconnect();
    assert.ok(await until(() => state.heldEnergy === null), 'a Companion that goes takes its hold with it');
  } finally {
    conn.disconnect();
    other.disconnect();
    await s.close();
  }
});

// presets.js and variables.js import Companion's own package, a dev
// dependency of the root package so these two run wherever the suite does.
test('Companion presets include 16 pads and the strobe', async () => {
  const { UpdatePresets } = await import('../../companion-module/src/presets.js');
  let presets = null;
  UpdatePresets({ liveState: {}, setPresetDefinitions: (_structure, defs) => { presets = defs; } });
  for (let n = 1; n <= 16; n++) {
    const pad = presets[`pad_${n}`];
    assert.ok(pad, `pad ${n}`);
    const bank = Math.floor((n - 1) / 8);
    const slot = (n - 1) % 8;
    assert.deepStrictEqual(pad.steps[0].down, [{ actionId: 'pad_hold', options: { bank, slot } }]);
    assert.deepStrictEqual(pad.steps[0].up, [{ actionId: 'pad_release', options: { bank, slot } }]);
  }
  assert.deepStrictEqual(presets.strobe_burst.steps[0].down.map((a) => a.actionId), ['strobe_burst']);
});

test('the variables name every pad and keep the energy override', async () => {
  const { UpdateVariableDefinitions, UpdateVariableValues } = await import('../../companion-module/src/variables.js');
  let defs = null;
  let values = null;
  const pads = { layout: [{ bank: 0, slot: 0, label: 'Rainbow' }, { bank: 1, slot: 7, label: 'Strobe' }], lit: [] };
  const self = { liveState: { pads }, setVariableDefinitions: (d) => { defs = d; }, setVariableValues: (v) => { values = v; } };
  UpdateVariableDefinitions(self);
  UpdateVariableValues(self);
  const ids = Array.isArray(defs) ? defs.map((d) => d.variableId) : Object.keys(defs);
  for (let n = 1; n <= 16; n++) assert.ok(ids.includes(`pad_${n}_label`), `pad_${n}_label`);
  assert.ok(ids.includes('energy_override'));
  assert.equal(values.pad_1_label, 'Rainbow');
  assert.equal(values.pad_16_label, 'Strobe');
  assert.equal(values.energy_override, 'off');
});

test('a refused token is reported as unauthorized, by the code the server sends', async () => {
  const server = http.createServer();
  const io = new Server(server);
  io.use((_socket, next) => {
    const err = new Error('Access token refused');
    err.data = { code: 'unauthorized', presented: true };
    next(err);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const statuses = [];
  const conn = new LightshowConnection({
    host: '127.0.0.1', port: server.address().port, token: 'wrong',
    onStatus: (status, message) => statuses.push([status, message]), onChange: () => {},
  });
  try {
    conn.connect();
    assert.ok(await until(() => statuses.some(([s]) => s === 'unauthorized' || s === 'error')));
    assert.deepStrictEqual(statuses.find(([s]) => s !== 'connecting'), ['unauthorized', 'Access token refused']);
  } finally {
    conn.disconnect?.();
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Companion renews held pads without pressing again", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const conn = new LightshowConnection({ host: 'localhost' });
  const posts = [];
  const renewed = true;
  conn.post = async (path, body) => {
    posts.push([path, body.token]);
    return path.endsWith('/renew') ? { ok: true, renewed } : { ok: true, id: 'v' };
  };
  await conn.holdPad(0, 3);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(400); await flush(); }
  assert.deepStrictEqual(posts.map(([p]) => p.split('/').at(-1)), ['press', 'renew', 'renew', 'renew', 'renew', 'renew']);
  assert.ok(posts.every(([, token]) => token === 'companion:0:3'));
  conn.disconnect();
});

test("Companion stops renewing when the hold no longer exists", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const conn = new LightshowConnection({ host: 'localhost' });
  const posts = [];
  let renewed = true;
  conn.post = async (path, body) => {
    posts.push([path, body.token]);
    return path.endsWith('/renew') ? { ok: true, renewed } : { ok: true, id: 'v' };
  };
  await conn.holdPad(0, 3);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(400); await flush(); }
  renewed = false;
  t.mock.timers.tick(400);
  await flush();
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(posts.length, 7, 'stopped at the first renewal that found no hold');
  conn.disconnect();
});

test("Companion release during a press prevents renewal", async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const conn = new LightshowConnection({ host: 'localhost' });
  const posts = [];
  const renewed = true;
  conn.post = async (path, body) => {
    posts.push([path, body.token]);
    return path.endsWith('/renew') ? { ok: true, renewed } : { ok: true, id: 'v' };
  };
  const pressing = conn.holdPad(1, 2);
  await conn.releasePad(1, 2);
  await pressing;
  t.mock.timers.tick(4000);
  await flush();
  assert.deepStrictEqual(posts.map(([p]) => p.split('/').at(-1)), ['press', 'release']);
  conn.disconnect();
});
