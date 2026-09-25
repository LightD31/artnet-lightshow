// Finding a WLED over mDNS, reading what it is, and adding it to the patch.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';

import { buildQuery, parseResponse, readInfo, readSegments, wledInfo, wledProfile } from '../../src/server/wled.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { state } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { stripOf } from '../../src/shared/placement.ts';

state.artnet.enabled = false;
state.running = false;
showStore.scheduleSave = () => {};   // never the real show file
test.after(() => stopEngine());

// ── mDNS ────────────────────────────────────────────────────────────────────

/** A DNS name, uncompressed. */
const name = (text) => Buffer.concat([...text.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
/** A resource record: owner, type, then rdata. */
function record(owner, type, rdata) {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, fixed, rdata]);
}

test('the question asks for _wled._tcp.local instances', () => {
  const q = buildQuery();
  assert.deepStrictEqual([...q.subarray(0, 12)], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(q.subarray(12, 12 + 18).toString('latin1'), '\x05_wled\x04_tcp\x05local\x00');
  assert.deepStrictEqual([...q.subarray(-4)], [0, 12, 0, 1], 'PTR, IN');
});

test('an answer names the WLED and where it is, compressed names and all', () => {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
  // PTR _wled._tcp.local → "Porch._wled._tcp.local", its SRV → porch.local, and porch.local's A.
  const ptrOwner = name('_wled._tcp.local');
  const instance = Buffer.concat([Buffer.from([5]), Buffer.from('Porch'), Buffer.from([0xc0, 12])]); // "Porch" + pointer to the service name
  const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 80]), name('porch.local')]);
  const packet = Buffer.concat([
    header,
    record(ptrOwner, 12, instance),
    record(Buffer.concat([Buffer.from([5]), Buffer.from('Porch'), Buffer.from([0xc0, 12])]), 33, srvData),
    record(name('porch.local'), 1, Buffer.from([192, 168, 1, 77])),
  ]);
  assert.deepStrictEqual(parseResponse(packet, '10.9.9.9'), [{ name: 'Porch', host: '192.168.1.77' }]);

  // No SRV or A: the address the answer came from.
  const bare = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), record(ptrOwner, 12, instance)]);
  assert.deepStrictEqual(parseResponse(bare, '10.9.9.9'), [{ name: 'Porch', host: '10.9.9.9' }]);

  // Anything else, or nonsense, names nobody.
  assert.deepStrictEqual(parseResponse(Buffer.concat([header.subarray(0, 12), record(name('_http._tcp.local'), 12, instance)]), '1.1.1.1'), []);
  assert.deepStrictEqual(parseResponse(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]), '1.1.1.1'), [], 'a pointer to itself');
  assert.deepStrictEqual(parseResponse(Buffer.alloc(5), '1.1.1.1'), []);
});

// ── What a WLED is ──────────────────────────────────────────────────────────

// Trimmed from a WLED 0.15 /json/info.
const INFO = {
  ver: '0.15.0', name: 'Porch', mac: 'a1b2c3d4e5f6', arch: 'esp32',
  leds: { count: 60, pwr: 0, fps: 42, maxpwr: 850, maxseg: 32, lc: 1, seglc: [1] },
};

test('what a WLED says it is', () => {
  assert.deepStrictEqual(readInfo(INFO, 'x'), { name: 'Porch', version: '0.15.0', leds: 60, rgbw: false, matrix: null, mac: 'a1b2c3d4e5f6' });
  assert.strictEqual(readInfo({ ...INFO, leds: { count: 30, lc: 3 } }, 'x').rgbw, true, 'lc bit 2 is a white channel');
  assert.strictEqual(readInfo({ ...INFO, leds: { count: 30, rgbw: true } }, 'x').rgbw, true, 'as older builds said it');
  assert.deepStrictEqual(readInfo({ ...INFO, leds: { count: 256, lc: 1, matrix: { w: 16, h: 16 } } }, 'x').matrix, { w: 16, h: 16 });
  assert.throws(() => readInfo({ name: 'Printer' }, '10.0.0.3'), (err) => err.status === 502 && /10.0.0.3 is not a WLED/.test(err.message));
});

test('its profile: a strip of its LEDs, a panel when it is one', () => {
  const strip = wledProfile(readInfo(INFO, 'x'), '10.0.0.50');
  assert.strictEqual(strip.id, 'wled-a1b2c3d4e5f6');
  assert.strictEqual(strip.name, 'Porch');
  assert.strictEqual(strip.modeName, '60 pixels, RGB');
  assert.strictEqual(strip.channelCount, 180);
  assert.deepStrictEqual(strip.cells[59].channelMap, { red: 177, green: 178, blue: 179 });

  const long = wledProfile(readInfo({ ...INFO, leds: { count: 300, lc: 3 } }, 'x'), 'x');
  assert.deepStrictEqual(stripOf(long), { width: 4, perUniverse: 128, universes: 3 }, 'RGBW, over three universes');

  const panel = wledProfile(readInfo({ ...INFO, leds: { count: 256, lc: 1, matrix: { w: 16, h: 16 } } }, 'x'), 'x');
  assert.deepStrictEqual(panel.grid, { columns: 16, rows: 16 });
  assert.strictEqual(panel.modeName, '256 pixels, RGB, 16 × 16');

  const one = wledProfile(readInfo({ ...INFO, leds: { count: 1, lc: 1 } }, 'x'), 'x');
  assert.deepStrictEqual([one.cells, one.channelMap], [undefined, { red: 0, green: 1, blue: 2 }], 'one LED is one light');

  const matrix = wledProfile(readInfo({ ...INFO, leds: { count: 2048, lc: 1, matrix: { w: 64, h: 32 } } }, 'x'), 'x');
  assert.deepStrictEqual([matrix.grid, matrix.channelCount, stripOf(matrix).universes], [{ columns: 64, rows: 32 }, 6144, 13],
    'a 64 × 32 matrix, over thirteen universes');
  assert.throws(() => wledProfile(readInfo({ ...INFO, leds: { count: 5000, lc: 1 } }, 'x'), 'x'),
    (err) => err.status === 400 && /5000 LEDs; a fixture takes up to 4096/.test(err.message));
  const noMac = wledProfile({ ...readInfo(INFO, 'x'), mac: null }, 'WLED-Porch.local');
  assert.strictEqual(noMac.id, 'wled-wled-porch-local');
});

// Trimmed from a WLED 0.15 /json/state: a booth front and two sides on one
// strip, and a 64 × 32 panel split into a left half and a right half.
const STRIP_STATE = {
  on: true, bri: 128,
  seg: [
    { id: 0, start: 0, stop: 120, len: 120, n: 'Front', on: true },
    { id: 1, start: 120, stop: 180, len: 60, on: true },
    { id: 2, start: 180, stop: 240, len: 60, n: 'Right side', on: true },
    { id: 3, start: 240, stop: 240, len: 0 },                     // empty: left out
    { id: 4, start: 230, stop: 400, len: 170 },                   // past the end: left out
  ],
};
const PANEL_INFO = { ...INFO, name: 'Wall', mac: '00112233aabb', leds: { count: 2048, lc: 1, matrix: { w: 64, h: 32 } } };
const PANEL_STATE = {
  seg: [
    { id: 0, start: 0, stop: 32, startY: 0, stopY: 32, n: 'Left' },
    { id: 1, start: 32, stop: 64, startY: 0, stopY: 32, n: 'Right' },
  ],
};

test('a WLED\'s segments: the stretch of its LEDs each covers, or on a panel the rectangle', () => {
  const strip = readSegments(STRIP_STATE, readInfo({ ...INFO, leds: { count: 240, lc: 1 } }, 'x'), 'x');
  assert.deepStrictEqual(strip.map((g) => [g.id, g.name, g.at, g.count, g.grid, g.rowStride]), [
    [0, 'Front', 0, 120, null, null],
    [1, 'Segment 2', 120, 60, null, null],
    [2, 'Right side', 180, 60, null, null],
  ]);
  const panel = readSegments(PANEL_STATE, readInfo(PANEL_INFO, 'x'), 'x');
  assert.deepStrictEqual(panel.map((g) => [g.name, g.at, g.count, g.grid, g.rowStride]), [
    ['Left', 0, 1024, { columns: 32, rows: 32 }, 64],
    ['Right', 32, 1024, { columns: 32, rows: 32 }, 64],
  ], 'each half\'s rows lie a panel\'s width apart');
  assert.throws(() => readSegments({ on: true }, readInfo(INFO, 'x'), '10.0.0.9'), /10.0.0.9 is not a WLED: its state lists no segments/);

  const right = wledProfile(readInfo(PANEL_INFO, 'x'), 'x', panel[1]);
  assert.deepStrictEqual([right.id, right.name, right.modeName, right.grid, right.channelCount],
    ['wled-00112233aabb-seg1', 'Wall · Right', '1024 pixels, RGB, 32 × 32, from LED 33', { columns: 32, rows: 32 }, 3072]);
  assert.strictEqual(right.channelList, undefined, 'no channel list: the cells say it');
});

test('adding a WLED segment by segment: a fixture each, on its own LEDs and universes', async () => {
  const infos = { '10.0.0.60': { ...INFO, name: 'Booth', leds: { count: 240, lc: 1 } }, '10.0.0.61': PANEL_INFO };
  const states = { '10.0.0.60': STRIP_STATE, '10.0.0.61': PANEL_STATE };
  const client = { ...fakeClient(infos), segments: async (host, info) => readSegments(states[host], info, host) };
  await withApp(client, async (call) => {
    const booth = await call('/api/wled/add', { host: '10.0.0.60', segments: true });
    assert.strictEqual(booth.status, 200, JSON.stringify(booth.body));
    assert.deepStrictEqual(booth.body.fixtures.map((f) => [f.label, f.universe, f.output]), [
      ['Booth · Front', 1, { protocol: 'ddp', host: '10.0.0.60', at: 0 }],
      ['Booth · Segment 2', 2, { protocol: 'ddp', host: '10.0.0.60', at: 120 }],
      ['Booth · Right side', 3, { protocol: 'ddp', host: '10.0.0.60', at: 180 }],
    ]);
    const again = await call('/api/wled/add', { host: '10.0.0.60', segments: true });
    assert.deepStrictEqual([again.status, again.body.error], [409, 'Every segment of Booth is patched already']);
    const whole = await call('/api/wled/add', { host: '10.0.0.60' });
    assert.strictEqual(whole.status, 409, 'all of it, on top of its segments');

    const wall = await call('/api/wled/add', { host: '10.0.0.61', segments: true, label: 'Wall' });
    assert.strictEqual(wall.status, 200, JSON.stringify(wall.body));
    assert.deepStrictEqual(wall.body.fixtures.map((f) => f.output), [
      { protocol: 'ddp', host: '10.0.0.61', at: 0, rowStride: 64 },
      { protocol: 'ddp', host: '10.0.0.61', at: 32, rowStride: 64 },
    ]);
    const found = await call('/api/wled/discover');
    assert.deepStrictEqual(found.body.devices.map((d) => [d.host, d.segments, d.patched]), [
      ['10.0.0.60', 3, 'Booth · Front, Booth · Segment 2, Booth · Right side'],
      ['10.0.0.61', 2, 'Wall · Left, Wall · Right'],
    ]);
  });
});

test('asking a WLED over HTTP, and what goes wrong', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/info') { res.writeHead(404); res.end(); return; }
    const reply = { '/ok': JSON.stringify(INFO) }[req.headers['x-case'] || '/ok'];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const got = await wledInfo('127.0.0.1', { port });
    assert.strictEqual(got.leds, 60);
    const html = await wledInfo('127.0.0.1', {
      port, fetchImpl: async () => new Response('<html>', { status: 200 }),
    }).catch((err) => err);
    assert.match(html.message, /is not a WLED: its \/json\/info is not JSON/);
    const gone = await wledInfo('127.0.0.1', { port, fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); } })
      .catch((err) => err);
    assert.deepStrictEqual([gone.status, /Cannot reach 127.0.0.1 \(fetch failed: ECONNREFUSED\)/.test(gone.message)], [502, true]);
    const slow = await wledInfo('127.0.0.1', { port, fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); } })
      .catch((err) => err);
    assert.strictEqual(slow.status, 504);
    const endless = await wledInfo('127.0.0.1', {
      port,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(32)); },
      })),
    }).catch((err) => err);
    assert.match(endless.message, /sent too much to be a WLED's info/, 'a body with no end is cut off');
  } finally {
    server.close();
  }
});

// ── Adding one ──────────────────────────────────────────────────────────────

async function withApp(client, fn) {
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, wled: client });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`,
      body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return { status: res.status, body: await res.json() };
  };
  const before = { fixtures: state.fixtures, next: state.nextFixtureId };
  state.fixtures = [{ id: 0, label: 'Par', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null }];
  try {
    await fn(call);
  } finally {
    state.fixtures = before.fixtures;
    state.nextFixtureId = before.next;
    await new Promise((r) => server.close(r));
  }
}

const fakeClient = (infos) => ({
  discover: async () => Object.keys(infos).map((host) => ({ host, name: infos[host].name || host })),
  info: async (host) => {
    if (!infos[host]) throw Object.assign(new Error(`Cannot reach ${host}`), { status: 502 });
    return readInfo(infos[host], host);
  },
});

test('adding a WLED patches it on universes of its own, sent DDP', async () => {
  const infos = {
    '10.0.0.50': { ...INFO, leds: { count: 300, lc: 1 } },
    '10.0.0.51': { ...INFO, name: 'Garden', mac: '0000000000aa', leds: { count: 60, lc: 1 } },
  };
  await withApp(fakeClient(infos), async (call) => {
    const added = await call('/api/wled/add', { host: '10.0.0.50' });
    assert.strictEqual(added.status, 200, JSON.stringify(added.body));
    assert.deepStrictEqual(
      [added.body.fixture.label, added.body.fixture.universe, added.body.fixture.address, added.body.fixture.output],
      ['Porch', 1, 1, { protocol: 'ddp', host: '10.0.0.50' }],
      'from universe 1: the rig\'s default universe 0 stays clear');
    // 300 pixels is universes 1 and 2; the next WLED goes after them.
    const second = await call('/api/wled/add', { host: '10.0.0.51', label: 'Garden strip' });
    assert.deepStrictEqual([second.body.fixture.label, second.body.fixture.universe], ['Garden strip', 3]);
    assert.strictEqual(state.fixtures.length, 3);

    const again = await call('/api/wled/add', { host: '10.0.0.50' });
    assert.deepStrictEqual([again.status, /patched already, as "Porch"/.test(again.body.error)], [409, true]);
    const moved = await call('/api/wled/add', { host: '10.0.0.99' });
    assert.strictEqual(moved.status, 502, 'a host that does not answer');
    assert.strictEqual((await call('/api/wled/add', { host: 'http://x' })).status, 400);

    const found = await call('/api/wled/discover');
    assert.deepStrictEqual(found.body.devices.map((d) => [d.host, d.leds, d.patched]),
      [['10.0.0.50', 300, 'Porch'], ['10.0.0.51', 60, 'Garden strip']]);
  });
});

test('the pre-show check asks every WLED in the patch', async () => {
  const { checkWled } = await import('../../src/server/preflight.ts');
  const before = state.fixtures;
  const { registerProfile } = await import('../../src/server/profiles.ts');
  registerProfile(wledProfile(readInfo({ ...INFO, leds: { count: 60, lc: 1 } }, 'x'), 'x'));
  try {
    state.fixtures = [];
    assert.strictEqual((await checkWled(fakeClient({}))).status, 'info');
    state.fixtures = [{ id: 5, label: 'Porch', address: 1, universe: 1, profileId: 'wled-a1b2c3d4e5f6', output: { protocol: 'ddp', host: '10.0.0.50' } }];
    const ok = await checkWled(fakeClient({ '10.0.0.50': INFO }));
    assert.deepStrictEqual([ok.status, ok.detail], ['ok', '"Porch" at 10.0.0.50, 60 LEDs, sent over DDP.']);
    const resized = await checkWled(fakeClient({ '10.0.0.50': { ...INFO, leds: { count: 50, lc: 1 } } }));
    assert.deepStrictEqual([resized.status, /reports 50 LEDs but is patched as 60/.test(resized.detail)], ['warn', true]);
    const silent = await checkWled(fakeClient({}));
    assert.deepStrictEqual([silent.status, /"Porch" at 10.0.0.50 does not answer/.test(silent.detail)], ['fail', true]);

    // A segment only has to fit: its 60 LEDs from LED 181 on a WLED of 240.
    state.fixtures = [{ id: 6, label: 'Side', address: 1, universe: 1, profileId: 'wled-a1b2c3d4e5f6', output: { protocol: 'ddp', host: '10.0.0.50', at: 180 } }];
    const fits = await checkWled(fakeClient({ '10.0.0.50': { ...INFO, leds: { count: 240, lc: 1 } } }));
    assert.strictEqual(fits.status, 'ok', fits.detail);
    const short = await checkWled(fakeClient({ '10.0.0.50': { ...INFO, leds: { count: 200, lc: 1 } } }));
    assert.deepStrictEqual([short.status, short.detail], ['warn', '"Side" reaches LED 240, but its WLED reports 200']);
  } finally {
    state.fixtures = before;
  }
});
