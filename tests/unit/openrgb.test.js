// OpenRGB over its SDK: the packets, what a device's description parses to,
// the profile a device becomes, the routes that find and add one, identify,
// the transmitter sending a device's universes as one UPDATELEDS a frame and
// ending on disarm, the wire itself against a fake server, and the pre-show
// check.

import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import express from 'express';

import {
  buildPacket, parseHeader, buildUpdateLeds, buildUpdateMode, parseUpdateLeds, parseControllerData, directMode,
  closeOpenRgb, OPENRGB_PORT, PACKET,
} from '../../src/server/openrgb.ts';
import { openrgbProfile } from '../../src/server/openrgb-devices.ts';
import { openrgbRoutes, openrgbPixels, openrgbConflict } from '../../src/server/openrgb-routes.ts';
import { ddpConflict } from '../../src/server/ddp-routes.ts';
import { createTransmitter } from '../../src/server/transmit.ts';
import { fixtureMessageSchema, showSchema, validate } from '../../src/server/validation.ts';
import { attachRoutes } from '../../src/server/routes.ts';
import { state } from '../../src/server/state.ts';
import { showStore } from '../../src/server/show-store.ts';
import { stopEngine } from '../../src/server/engine.ts';
import { checkOpenRgb } from '../../src/server/preflight.ts';
import { stripOf } from '../../src/shared/placement.ts';

state.artnet.enabled = false;
state.running = false;
showStore.scheduleSave = () => {};   // never the real show file
test.after(() => stopEngine());

// ── A fake SDK server ───────────────────────────────────────────────────────
// Speaks what the client needs: the version, the count, each device's
// description (at the version the client asks for), and it keeps every
// UPDATELEDS and UPDATEMODE it is sent.

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; };
const str = (text) => { const b = Buffer.from(`${text}\0`, 'utf8'); return Buffer.concat([u16(b.length), b]); };

/** A mode as the server describes it, at protocol `version` (3 added brightness). */
function encodeMode(name, { flags = 0, colorMode = 0, colors = 0 } = {}, version) {
  const parts = [str(name), i32(0), u32(flags), u32(0), u32(0)];
  if (version >= 3) parts.push(u32(0), u32(100));
  parts.push(u32(0), u32(0), u32(0));
  if (version >= 3) parts.push(u32(100));
  parts.push(u32(0), u32(colorMode), u16(colors));
  for (let c = 0; c < colors; c++) parts.push(u32(0));
  return Buffer.concat(parts);
}

const DIRECT = ['Direct', { flags: 1 << 5, colorMode: 1 }];
const RAINBOW = ['Rainbow', { flags: 1, colors: 0 }];

/** A controller's description: `leds` LEDs in one zone, with a matrix map when asked, at protocol `version`. */
function encodeController({ name, type = 1, leds = 8, modes = [DIRECT, RAINBOW], activeMode = 0, colors = null, matrix = false }, version) {
  const parts = [i32(type), str(name)];
  if (version >= 1) parts.push(str('Vendor'));
  parts.push(str('A device'), str('1.0'), str('SN'), str('bus'));
  parts.push(u16(modes.length), i32(activeMode));
  for (const [modeName, opts] of modes) parts.push(encodeMode(modeName, opts, version));
  parts.push(u16(1), str('Zone'), i32(1), u32(leds), u32(leds), u32(leds));
  if (matrix) {
    const rows = 2;
    const columns = Math.ceil(leds / rows);
    const map = [u32(rows), u32(columns)];
    for (let i = 0; i < rows * columns; i++) map.push(u32(i < leds ? i : 0xffffffff));
    const bytes = Buffer.concat(map);
    parts.push(u16(bytes.length), bytes);
  } else {
    parts.push(u16(0));
  }
  if (version >= 4) parts.push(u16(0));
  parts.push(u16(leds));
  for (let l = 0; l < leds; l++) parts.push(str(`LED ${l + 1}`), u32(0));
  parts.push(u16(leds));
  for (let l = 0; l < leds; l++) {
    const c = colors ? colors[l] : [0, 0, 0];
    parts.push(Buffer.from([c[0], c[1], c[2], 0]));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 4), body]);
}

/** The gaming PC: four RAM sticks, a GPU, a board, a keyboard, two monitors, one device with no LEDs, a mouse. */
const rig = () => [
  { name: 'Trident Z A', type: 1, leds: 8 }, { name: 'Trident Z B', type: 1, leds: 8 },
  { name: 'Trident Z C', type: 1, leds: 8 }, { name: 'Trident Z D', type: 1, leds: 8 },
  { name: 'RTX 4080', type: 2, leds: 5 }, { name: 'B650 Board', type: 0, leds: 85, activeMode: 1 },
  { name: 'Keyboard', type: 5, leds: 117, matrix: true }, { name: 'Monitor L', type: 11, leds: 48 }, { name: 'Monitor R', type: 11, leds: 48 },
  { name: 'Fan hub', type: 3, leds: 0 }, { name: 'Mouse', type: 6, leds: 2 },
];

async function fakeServer(devices = rig(), { version = 4, answerVersion = true } = {}) {
  const log = { leds: [], modes: [], names: [], connections: 0, closed: 0 };
  const server = net.createServer((socket) => {
    log.connections++;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16) {
        const header = parseHeader(buf);
        if (buf.length < 16 + header.length) break;
        const data = buf.subarray(16, 16 + header.length);
        buf = buf.subarray(16 + header.length);
        const reply = (d) => socket.write(buildPacket(header.device, header.id, d));
        if (header.id === PACKET.REQUEST_PROTOCOL_VERSION) { if (answerVersion) reply(u32(version)); }
        else if (header.id === PACKET.SET_CLIENT_NAME) log.names.push(data.toString('utf8').replace(/\0$/, ''));
        else if (header.id === PACKET.REQUEST_CONTROLLER_COUNT) reply(u32(devices.length));
        else if (header.id === PACKET.REQUEST_CONTROLLER_DATA) {
          if (header.device < devices.length) reply(encodeController(devices[header.device], data.length >= 4 ? data.readUInt32LE(0) : 0));
        } else if (header.id === PACKET.RGBCONTROLLER_UPDATELEDS) log.leds.push({ device: header.device, ...parseUpdateLeds(data) });
        else if (header.id === PACKET.RGBCONTROLLER_UPDATEMODE) {
          log.modes.push({ device: header.device, mode: data.readInt32LE(4) });
          devices[header.device].activeMode = data.readInt32LE(4);
        }
      }
    });
    socket.on('close', () => { log.closed++; });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, log, devices,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Wait for `cond`, calling `each` (a frame) on the way. */
async function until(cond, { ms = 4000, each = null, step = 15, what = 'the condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    if (each) each();
    if (cond()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

const dark = (rgb) => !Array.from(rgb).some((v) => v !== 0);

// ── Packets ─────────────────────────────────────────────────────────────────

test('a packet is "ORGB", the device, the packet id and the data length, little-endian', () => {
  const p = buildPacket(7, PACKET.REQUEST_PROTOCOL_VERSION, Buffer.from([3, 0, 0, 0]));
  assert.strictEqual(p.length, 20);
  assert.strictEqual(p.subarray(0, 4).toString('ascii'), 'ORGB');
  assert.deepStrictEqual([...p.subarray(4, 16)], [7, 0, 0, 0, 40, 0, 0, 0, 4, 0, 0, 0]);
  assert.deepStrictEqual(parseHeader(p), { device: 7, id: 40, length: 4 });
  assert.strictEqual(parseHeader(Buffer.from('Art-Net\0........')), null);
  assert.strictEqual(parseHeader(Buffer.alloc(8)), null);
});

test('UPDATELEDS: the data is its own length, the LED count, then R, G, B and a zero byte a LED', () => {
  // Two LEDs given, three asked for: the third is dark.
  const p = buildUpdateLeds(5, Uint8Array.from([255, 16, 1, 9, 8, 7]), 3);
  assert.deepStrictEqual(parseHeader(p), { device: 5, id: 1050, length: 4 + 2 + 3 * 4 });
  const data = p.subarray(16);
  assert.strictEqual(data.readUInt32LE(0), 18, 'the data length counts itself');
  assert.strictEqual(data.readUInt16LE(4), 3);
  assert.deepStrictEqual([...data.subarray(6, 18)], [255, 16, 1, 0, 9, 8, 7, 0, 0, 0, 0, 0]);
  assert.strictEqual(data.readUInt32LE(6), 0x000110ff, 'read as a little-endian word: 0x00BBGGRR');
  assert.deepStrictEqual(parseUpdateLeds(data), { count: 3, rgb: Uint8Array.from([255, 16, 1, 9, 8, 7, 0, 0, 0]) });
  assert.strictEqual(buildUpdateLeds(0, new Uint8Array(0), 0).length, 16 + 6, 'no LEDs is still a packet');
});

test('a controller\'s description parses at protocol 0, 3 and 4, and its modes come back verbatim', () => {
  for (const version of [0, 3, 4]) {
    const raw = encodeController({ name: 'B650 Board', type: 0, leds: 85, activeMode: 1, colors: Array.from({ length: 85 }, (_, i) => [i, 2, 3]), matrix: true }, version);
    const data = parseControllerData(raw, version);
    assert.deepStrictEqual([data.name, data.type, data.leds, data.activeMode], ['B650 Board', 'Motherboard', 85, 1], `at protocol ${version}`);
    assert.deepStrictEqual(data.modes.map((m) => [m.index, m.name, m.perLed]), [[0, 'Direct', true], [1, 'Rainbow', false]]);
    assert.ok(data.modes[0].raw.equals(encodeMode('Direct', DIRECT[1], version)), 'the mode\'s bytes, to send back in UPDATEMODE');
    assert.deepStrictEqual([...data.colors.subarray(0, 6)], [0, 2, 3, 1, 2, 3]);
    assert.strictEqual(directMode(data).index, 0);
  }
  const noDirect = parseControllerData(encodeController({ name: 'Mouse', type: 6, leds: 2, modes: [RAINBOW, ['Custom', { colorMode: 1 }]] }, 3), 3);
  assert.strictEqual(directMode(noDirect).name, 'Custom', 'a mode that takes a colour a LED stands in for Direct');
  assert.strictEqual(directMode(parseControllerData(encodeController({ name: 'Fan', type: 3, leds: 0, modes: [RAINBOW] }, 3), 3)), null);
  assert.throws(() => parseControllerData(Buffer.alloc(10), 3), /ends early/);

  const mode = buildUpdateMode(5, noDirect.modes[1]);
  const body = mode.subarray(16);
  assert.deepStrictEqual([parseHeader(mode).id, body.readUInt32LE(0), body.readInt32LE(4)], [1101, body.length, 1]);
  assert.ok(body.subarray(8).equals(noDirect.modes[1].raw));
});

// ── The profile ─────────────────────────────────────────────────────────────

test('a device\'s profile: its LEDs as cells of red, green and blue; one light when it has one LED', () => {
  const board = openrgbProfile({ index: 5, name: 'B650 Board', type: 'Motherboard', leds: 85 }, '10.0.0.80');
  assert.deepStrictEqual([board.id, board.name, board.manufacturer, board.modeName, board.channelCount, board.cells.length],
    ['openrgb-10-0-0-80-5', 'B650 Board', 'OpenRGB', '85 LEDs, RGB, Motherboard', 255, 85]);
  assert.deepStrictEqual(board.cells[84].channelMap, { red: 252, green: 253, blue: 254 });
  assert.deepStrictEqual(board.channelMap, {});
  assert.strictEqual(stripOf(board), null, 'inside one universe');
  const keyboard = openrgbProfile({ index: 6, name: 'Keyboard', type: 'Keyboard', leds: 117 }, 'gamer-pc.lan', 6743);
  assert.deepStrictEqual([keyboard.id, keyboard.channelCount], ['openrgb-gamer-pc-lan-6743-6', 351], 'another port is in the id');
  const one = openrgbProfile({ index: 0, name: 'Fan', type: 'Cooler', leds: 1 }, '10.0.0.80', OPENRGB_PORT);
  assert.deepStrictEqual([one.cells, one.channelMap, one.modeName], [undefined, { red: 0, green: 1, blue: 2 }, '1 LED, RGB, Cooler']);
  assert.strictEqual(openrgbProfile({ index: 0, name: 'X', type: 'Unknown', leds: 2 }, 'h').modeName, '2 LEDs, RGB');
  const long = openrgbProfile({ index: 1, name: 'Strip', type: 'LED strip', leds: 300 }, 'h');
  assert.deepStrictEqual(stripOf(long), { width: 3, perUniverse: 170, universes: 2 }, 'a long one runs on into the next universe');
  assert.throws(() => openrgbProfile({ index: 9, name: 'Fan hub', type: 'Cooler', leds: 0 }, 'h'), (err) => err.status === 400 && /reports no LEDs/.test(err.message));
  assert.throws(() => openrgbProfile({ index: 9, name: 'Wall', type: 'Light', leds: 5000 }, 'h'), (err) => err.status === 400 && /a fixture takes up to 4096/.test(err.message));
});

// ── The output shape ────────────────────────────────────────────────────────

test('the output: protocol, host, device and LED count, and a port when not the default', () => {
  const ok = (output) => validate(fixtureMessageSchema, { id: 1, output }, 'fixture').output;
  assert.deepStrictEqual(ok({ protocol: 'openrgb', host: '10.0.0.80', device: 3, leds: 8 }), { protocol: 'openrgb', host: '10.0.0.80', device: 3, leds: 8 });
  assert.strictEqual(ok({ protocol: 'openrgb', host: 'gamer-pc.lan', port: 6743, device: 0, leds: 1 }).port, 6743);
  assert.strictEqual(ok(null), null);
  for (const bad of [
    { protocol: 'openrgb', host: '10.0.0.80', device: 3 },
    { protocol: 'openrgb', host: '10.0.0.80', device: -1, leds: 8 },
    { protocol: 'openrgb', host: '10.0.0.80', device: 3, leds: 0 },
    { protocol: 'openrgb', host: '10.0.0.80', device: 3, leds: 8, name: 'x' },
    { protocol: 'openrgb', host: 'http://x', device: 3, leds: 8 },
    { protocol: 'hue', bridge: 'b1', channel: 0 },
  ]) assert.throws(() => ok(bad), `${JSON.stringify(bad)} is refused`);
  const show = validate(showSchema, { fixtures: [{ label: 'RAM', profileId: 'p', output: { protocol: 'openrgb', host: '10.0.0.80', device: 0, leds: 8 } }] }, 'show');
  assert.strictEqual(show.fixtures[0].output.protocol, 'openrgb');
});

// ── Routes and conflicts ────────────────────────────────────────────────────

const PROFILES = {
  ram: openrgbProfile({ index: 0, name: 'RAM', type: 'DRAM', leds: 8 }, '10.0.0.80'),
  par: { id: 'par', name: 'Par', channelCount: 12, channelMap: { dimmer: 0, red: 3, green: 4, blue: 5 } },
};
const profileOf = (f) => PROFILES[f.profileId];
const universeOf = (f) => f.universe;
const ram = (id, universe, device, extra = {}) => ({
  id, label: `RAM ${id}`, address: 1, universe, profileId: 'ram', output: { protocol: 'openrgb', host: '10.0.0.80', device, leds: 8 }, ...extra,
});

test('a device\'s route: its universes\' bytes, how wide a cell is and where its colour sits', () => {
  const routes = openrgbRoutes([ram(1, 3, 0), { id: 2, label: 'Par', address: 1, universe: 0, profileId: 'par' }], profileOf, universeOf);
  assert.deepStrictEqual(routes, [{
    host: '10.0.0.80', port: 6742, device: 0, leds: 8, parts: [{ universe: 3, from: 0, bytes: 24 }], width: 3, rgb: [0, 1, 2],
  }]);
  const frame = new Uint8Array(512);
  for (let i = 0; i < 24; i++) frame[i] = i + 1;
  assert.deepStrictEqual([...openrgbPixels(routes[0], () => frame)], Array.from({ length: 24 }, (_, i) => i + 1));

  // A par's profile put on the device by hand: the first LED gets its colour, the rest stay dark.
  const [odd] = openrgbRoutes([ram(1, 3, 0, { profileId: 'par' })], profileOf, universeOf);
  assert.deepStrictEqual([odd.width, odd.rgb], [12, [3, 4, 5]]);
  const parFrame = new Uint8Array(512);
  parFrame.set([255, 0, 0, 10, 20, 30], 0);
  assert.deepStrictEqual([...openrgbPixels(odd, () => parFrame).subarray(0, 6)], [10, 20, 30, 0, 0, 0]);
});

test('a device is one fixture\'s, and its universes are its alone', () => {
  assert.strictEqual(openrgbConflict([ram(1, 3, 0), ram(2, 4, 1)]), null);
  assert.match(openrgbConflict([ram(1, 3, 0), ram(2, 4, 0)]), /"RAM 2" and "RAM 1" are both OpenRGB device #0 at 10.0.0.80/);
  assert.match(ddpConflict([ram(1, 3, 0), { ...ram(2, 4, 0), output: { ...ram(2, 4, 0).output, port: 6742 } }], profileOf, universeOf), /both OpenRGB device #0/);
  assert.match(ddpConflict([ram(1, 3, 0), { id: 2, label: 'Par', address: 100, universe: 3, profileId: 'par' }], profileOf, universeOf),
    /"Par" is on universe 3, which goes to "RAM 1"'s OpenRGB device and nowhere else/);
  assert.match(ddpConflict([ram(1, 3, 0), ram(2, 3, 1)], profileOf, universeOf), /"RAM 2" and "RAM 1" both send universe 3 to an OpenRGB device/);
});

// ── The transmitter ─────────────────────────────────────────────────────────

function fakeWires() {
  const sent = [];
  return {
    sent,
    wires: {
      artnet: (target, frame) => { sent.push({ wire: 'artnet', universe: target.universe, dark: dark(frame) }); return true; },
      artnetSync: () => true,
      sacn: () => true,
      sacnDiscovery: () => true,
      ddp: () => true,
      openrgb: (target, rgb) => { sent.push({ wire: 'openrgb', device: target.device, leds: target.leds, dark: dark(rgb), rgb: Array.from(rgb) }); return true; },
      openrgbClose: (target) => { sent.push({ wire: 'close', host: `${target.host}:${target.port}` }); return true; },
    },
  };
}

const ROUTES = [
  { host: '10.0.0.80', port: 6742, device: 3, leds: 8, parts: [{ universe: 5, from: 0, bytes: 24 }], width: 3, rgb: [0, 1, 2] },
  { host: '10.0.0.80', port: 6742, device: 6, leds: 4, parts: [{ universe: 6, from: 0, bytes: 12 }], width: 3, rgb: [0, 1, 2] },
];
const outputs = (armed, openrgb = ROUTES) => ({
  artnet: { enabled: true, host: '10.0.0.9', port: 6454, sync: false, routes: null },
  sacn: { enabled: false, host: '', priority: 100, sourceName: 'x', universeOffset: 1, cid: '', interface: '' },
  delayMs: 0,
  openrgb,
  armed,
});
const LIT = Buffer.alloc(512, 7);

/** One frame: the par universe, both devices' universes, and the frame's end. */
function frame(tx, config) {
  tx.send(0, LIT, config);
  tx.send(5, LIT, config);
  tx.send(6, LIT, config);
  tx.endFrame(config);
}

test('transmit: a device\'s universes go to it as one packet a frame, and never on Art-Net', () => {
  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  const config = outputs(true);
  assert.deepStrictEqual(tx.send(5, LIT, config), ['openrgb']);
  assert.deepStrictEqual(tx.send(0, LIT, config), ['artnet']);
  tx.send(6, LIT, config);
  tx.endFrame(config);
  assert.deepStrictEqual(sent.filter((p) => p.wire === 'artnet').map((p) => p.universe), [0]);
  const packets = sent.filter((p) => p.wire === 'openrgb');
  assert.deepStrictEqual(packets.map((p) => [p.device, p.leds, p.rgb.length, p.dark]), [[3, 8, 24, false], [6, 4, 12, false]]);
  assert.ok(packets[0].rgb.every((v) => v === 7));
});

test('transmit: the armed gate — nothing while disarmed, one dark packet a device and the connection closed on disarm, frames again on arm', () => {
  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  frame(tx, outputs(false));
  frame(tx, outputs(false));
  assert.deepStrictEqual(sent, [], 'started disarmed: nothing, not even a dark packet');

  frame(tx, outputs(true));
  assert.deepStrictEqual(sent.map((p) => [p.wire, p.device ?? p.universe, p.dark]), [['artnet', 0, false], ['openrgb', 3, false], ['openrgb', 6, false]]);
  sent.length = 0;

  frame(tx, outputs(false));
  assert.deepStrictEqual(sent, [
    { wire: 'artnet', universe: 0, dark: true },
    { wire: 'openrgb', device: 3, leds: 8, dark: true, rgb: new Array(24).fill(0) },
    { wire: 'openrgb', device: 6, leds: 4, dark: true, rgb: new Array(12).fill(0) },
    { wire: 'close', host: '10.0.0.80:6742' },
  ], 'the transition: one dark packet per device, then the server hung up on, once');
  sent.length = 0;

  frame(tx, outputs(false));
  tx.send(5, LIT, outputs(false), { immediate: true, terminate: true });
  tx.endFrame(outputs(false));
  assert.deepStrictEqual(sent, [], 'disarmed: every frame is dropped');

  frame(tx, outputs(true));
  assert.deepStrictEqual(sent.map((p) => [p.wire, p.dark]), [['artnet', false], ['openrgb', false], ['openrgb', false]], 'armed again: the frames flow');
});

test('transmit: a device that leaves the patch is sent one dark packet; a server with none left is hung up on', () => {
  const { sent, wires } = fakeWires();
  const tx = createTransmitter({ wires });
  frame(tx, outputs(true));
  sent.length = 0;
  const one = [ROUTES[0]];
  tx.send(5, LIT, outputs(true, one));
  tx.endFrame(outputs(true, one));
  assert.deepStrictEqual(sent.map((p) => [p.wire, p.device, p.dark]), [['openrgb', 3, false], ['openrgb', 6, true]], 'device 6 gone: dark, and the server kept for device 3');
  sent.length = 0;
  tx.endFrame(outputs(true, []));
  assert.deepStrictEqual(sent, [{ wire: 'openrgb', device: 3, leds: 8, dark: true, rgb: new Array(24).fill(0) }, { wire: 'close', host: '10.0.0.80:6742' }]);
  sent.length = 0;
  tx.endFrame(outputs(true, []));
  assert.deepStrictEqual(sent, [], 'and nothing after');
});

test('transmit: a device held back for Hue waits until all its universes are in', () => {
  const { sent, wires } = fakeWires();
  let clock = 0;
  const tx = createTransmitter({ wires, now: () => clock });
  const long = [{ host: '10.0.0.80', port: 6742, device: 1, leds: 300, parts: [{ universe: 1, from: 0, bytes: 510 }, { universe: 2, from: 0, bytes: 390 }], width: 3, rgb: [0, 1, 2] }];
  const config = { ...outputs(true, long), delayMs: 50 };
  tx.send(1, LIT, config);
  tx.send(2, LIT, config);
  tx.endFrame(config);
  assert.strictEqual(sent.length, 0, 'in the delay line');
  clock = 60;
  tx.send(1, LIT, config);
  tx.send(2, LIT, config);
  tx.endFrame(config);
  assert.deepStrictEqual(sent.map((p) => [p.wire, p.device, p.rgb.length]), [['openrgb', 1, 900]]);
});

// ── The wire, against a server ──────────────────────────────────────────────

const noDmx = { artnet: { enabled: false, host: '10.0.0.9', port: 6454, sync: false, routes: null }, sacn: outputs(true).sacn, delayMs: 0 };

test('the wire: frames reach the server in its Direct mode; disarming sends black and hangs up; arming dials again', async () => {
  const server = await fakeServer();
  const route = { host: '127.0.0.1', port: server.port, device: 5, leds: 85, parts: [{ universe: 9, from: 0, bytes: 255 }], width: 3, rgb: [0, 1, 2] };
  const config = (armed) => ({ ...noDmx, openrgb: [route], armed });
  const lit = Buffer.alloc(512);
  lit.set([200, 100, 50], 0);
  lit.set([1, 2, 3], 252);
  const tx = createTransmitter();
  const paint = (armed) => { tx.send(9, lit, config(armed)); tx.endFrame(config(armed)); };
  try {
    const litFrame = (p) => p.device === 5 && p.count === 85 && p.rgb[0] === 200 && p.rgb[1] === 100 && p.rgb[2] === 50 && p.rgb[254] === 3;
    await until(() => server.log.leds.some(litFrame), { each: () => paint(true), what: 'a lit frame at the server' });
    assert.deepStrictEqual(server.log.names, ['ArtNet Lightshow']);
    assert.deepStrictEqual(server.log.modes, [{ device: 5, mode: 0 }], 'the board was in Rainbow: put in Direct first');
    assert.strictEqual(server.log.connections, 1);

    const seen = server.log.leds.length;
    paint(false);
    await until(() => server.log.leds.length > seen && server.log.closed === 1, { what: 'the dark frame and the hang-up' });
    const last = server.log.leds[server.log.leds.length - 1];
    assert.ok(last.device === 5 && last.count === 85 && dark(last.rgb), 'the last packet is dark');
    const afterDark = server.log.leds.length;
    paint(false);
    paint(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual([server.log.leds.length, server.log.connections], [afterDark, 1], 'disarmed: nothing is sent and nobody dials');

    await until(() => server.log.connections === 2 && server.log.leds.slice(afterDark).some(litFrame), { each: () => paint(true), what: 'a second connection carrying frames' });
  } finally {
    closeOpenRgb({ host: '127.0.0.1', port: server.port });
    await server.close();
  }
});

test('the wire: a server that never says its version is spoken to at protocol 0', { timeout: 10_000 }, async () => {
  const server = await fakeServer(rig(), { answerVersion: false });
  const route = { host: '127.0.0.1', port: server.port, device: 0, leds: 8, parts: [{ universe: 11, from: 0, bytes: 24 }], width: 3, rgb: [0, 1, 2] };
  const config = { ...noDmx, openrgb: [route], armed: true };
  const tx = createTransmitter();
  try {
    await until(() => server.log.leds.some((p) => p.device === 0 && p.count === 8), {
      ms: 6000, each: () => { tx.send(11, LIT, config); tx.endFrame(config); }, what: 'a frame after the version timeout',
    });
  } finally {
    closeOpenRgb({ host: '127.0.0.1', port: server.port });
    await server.close();
  }
});

// ── Discover, add, identify ─────────────────────────────────────────────────

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} } });
  const listener = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${listener.address().port}${path}`,
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
    await new Promise((r) => listener.close(r));
  }
}

test('discover lists the server\'s devices; add patches each on universes of its own, sent over the SDK', async () => {
  const server = await fakeServer();
  try {
    await withApp(async (call) => {
      const found = await call(`/api/openrgb/discover?host=127.0.0.1&port=${server.port}`);
      assert.strictEqual(found.status, 200, JSON.stringify(found.body));
      assert.deepStrictEqual([found.body.host, found.body.port, found.body.devices.length], ['127.0.0.1', server.port, 11]);
      assert.deepStrictEqual(found.body.devices[0], { index: 0, name: 'Trident Z A', type: 'DRAM', leds: 8, direct: true, patched: null });
      assert.deepStrictEqual(found.body.devices.map((d) => d.leds), [8, 8, 8, 8, 5, 85, 117, 48, 48, 0, 2]);
      assert.deepStrictEqual(found.body.devices.slice(4, 7).map((d) => d.type), ['GPU', 'Motherboard', 'Keyboard']);
      await until(() => server.log.closed === server.log.connections, { what: 'discover hanging up' });

      const two = await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, devices: [0, 5] });
      assert.strictEqual(two.status, 200, JSON.stringify(two.body));
      assert.deepStrictEqual(two.body.fixtures.map((f) => [f.label, f.universe, f.address, f.profileId, f.output]), [
        ['Trident Z A', 1, 1, `openrgb-127-0-0-1-${server.port}-0`, { protocol: 'openrgb', host: '127.0.0.1', port: server.port, device: 0, leds: 8 }],
        ['B650 Board', 2, 1, `openrgb-127-0-0-1-${server.port}-5`, { protocol: 'openrgb', host: '127.0.0.1', port: server.port, device: 5, leds: 85 }],
      ], 'from universe 1: the rig\'s default universe 0 stays clear');
      assert.deepStrictEqual(two.body.profiles.map((p) => [p.name, p.modeName]), [['Trident Z A', '8 LEDs, RGB, DRAM'], ['B650 Board', '85 LEDs, RGB, Motherboard']]);
      assert.strictEqual(state.fixtures.length, 3);

      const again = await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, devices: [0] });
      assert.deepStrictEqual([again.status, again.body.error], [409, 'Trident Z A (#0) is patched already, as "Trident Z A"']);
      assert.strictEqual((await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, devices: [99] })).status, 404);
      assert.match((await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, devices: [9] })).body.error, /has no LEDs to light/);

      const rest = await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, label: 'PC' });
      assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
      assert.deepStrictEqual(rest.body.fixtures.map((f) => [f.label, f.output.device]), [
        ['PC · Trident Z B', 1], ['PC · Trident Z C', 2], ['PC · Trident Z D', 3], ['PC · RTX 4080', 4], ['PC · Keyboard', 6],
        ['PC · Monitor L', 7], ['PC · Monitor R', 8], ['PC · Mouse', 10],
      ], 'every device with LEDs not patched yet; the one with none is skipped');
      assert.deepStrictEqual(rest.body.fixtures.map((f) => f.universe), [3, 4, 5, 6, 7, 8, 9, 10]);
      const all = await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port });
      assert.deepStrictEqual([all.status, all.body.error], [409, 'Every device of OpenRGB at 127.0.0.1 is patched already']);

      const listed = await call(`/api/openrgb/discover?host=127.0.0.1&port=${server.port}`);
      assert.deepStrictEqual(listed.body.devices.map((d) => d.patched).slice(0, 3), ['Trident Z A', 'PC · Trident Z B', 'PC · Trident Z C']);

      assert.strictEqual((await call('/api/openrgb/add', { host: 'http://x' })).status, 400);
      const nobody = await call('/api/openrgb/discover?host=127.0.0.1&port=1');
      assert.deepStrictEqual([nobody.status, /Cannot reach OpenRGB at 127.0.0.1:1/.test(nobody.body.error)], [502, true], JSON.stringify(nobody.body));
    });
  } finally {
    await server.close();
  }
});

test('identify: a device not in the patch is streamed the picture, then put back; one in the patch flashes through it', async () => {
  const devices = rig();
  devices[5].colors = Array.from({ length: 85 }, () => [10, 20, 30]);
  const server = await fakeServer(devices);
  try {
    await withApp(async (call) => {
      const flashed = await call('/api/openrgb/identify', { host: '127.0.0.1', port: server.port, device: 5, seconds: 1 });
      assert.strictEqual(flashed.status, 200, JSON.stringify(flashed.body));
      assert.deepStrictEqual([flashed.body.via, flashed.body.leds, flashed.body.name, flashed.body.remainingMs], ['device', 85, 'B650 Board', 1000]);
      await until(() => server.log.leds.length >= 2, { what: 'the picture streaming' });
      const first = server.log.leds[0];
      assert.deepStrictEqual([first.device, first.count, [...first.rgb.subarray(0, 3)], [...first.rgb.subarray(252, 255)]],
        [5, 85, [0, 255, 0], [255, 0, 0]], 'the first LED green, the last red');
      assert.deepStrictEqual(server.log.modes, [{ device: 5, mode: 0 }], 'put in Direct for the picture');
      await until(() => server.log.closed >= 1, { ms: 3000, what: 'identify ending' });
      const last = server.log.leds[server.log.leds.length - 1];
      assert.ok(Array.from(last.rgb).every((v, i) => v === [10, 20, 30][i % 3]), 'its colours put back');
      assert.deepStrictEqual(server.log.modes[server.log.modes.length - 1], { device: 5, mode: 1 }, 'and its Rainbow');

      assert.strictEqual((await call('/api/openrgb/identify', { host: '127.0.0.1', port: server.port, device: 99 })).status, 404);
      assert.strictEqual((await call('/api/openrgb/identify', { host: '127.0.0.1', port: 1, device: 0 })).status, 502);

      const added = await call('/api/openrgb/add', { host: '127.0.0.1', port: server.port, devices: [0] });
      const viaPatch = await call('/api/openrgb/identify', { host: '127.0.0.1', port: server.port, device: 0 });
      assert.deepStrictEqual([viaPatch.body.via, viaPatch.body.ids], ['patch', [added.body.fixtures[0].id]]);
      assert.strictEqual((await call('/api/identify/stop', {})).status, 200);
    });
  } finally {
    await server.close();
  }
});

// ── The pre-show check ──────────────────────────────────────────────────────

test('pre-show check: a server that does not answer is a warning naming its fixtures; a changed device warns; all well passes', async () => {
  const server = await fakeServer();
  const saved = state.fixtures;
  const on = (id, label, device, leds, port = server.port) => ({
    id, label, address: 1, universe: id, profileId: 'cameo-root-par-6-12ch', maxBrightness: 255, override: null,
    output: { protocol: 'openrgb', host: '127.0.0.1', port, device, leds },
  });
  try {
    state.fixtures = [];
    assert.strictEqual((await checkOpenRgb()).status, 'info');

    state.fixtures = [on(1, 'RAM A', 0, 8), on(2, 'Board', 5, 85)];
    const ok = await checkOpenRgb();
    assert.strictEqual(ok.status, 'ok', ok.detail);
    assert.strictEqual(ok.detail, `"RAM A" at 127.0.0.1:${server.port} #0 Trident Z A, 8 LEDs; "Board" at 127.0.0.1:${server.port} #5 B650 Board, 85 LEDs, sent over the OpenRGB SDK.`);

    state.fixtures = [on(1, 'RAM A', 0, 9), on(2, 'Board', 99, 85)];
    const changed = await checkOpenRgb();
    assert.strictEqual(changed.status, 'warn');
    assert.match(changed.detail, /"RAM A" \(Trident Z A\) reports 8 LEDs but is patched as 9; "Board" is device #99 at 127.0.0.1:\d+, which lists only 11/);

    state.fixtures = [on(1, 'RAM A', 0, 8), on(2, 'Board', 5, 85), on(3, 'Elsewhere', 0, 8, 1)];
    const silent = await checkOpenRgb();
    assert.strictEqual(silent.status, 'warn');
    assert.match(silent.detail, /^OpenRGB at 127.0.0.1:1 does not answer \(.*\); on it: "Elsewhere"$/);
    assert.match(silent.fix, /SDK server/);
  } finally {
    state.fixtures = saved;
    await server.close();
  }
});
