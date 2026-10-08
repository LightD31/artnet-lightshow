import test from 'node:test';
import assert from 'node:assert';

import { state } from '../../src/server/state.ts';
import * as output from '../../src/server/output.ts';
import { checkPatch, checkSacn, checkHue, checkPanns, checkAccess, checkMidi, probeCommand, STATUSES } from '../../src/server/preflight.ts';
import { buildArtPoll, parseArtPollReply } from '../../src/server/artnet.ts';
import { settings } from '../../src/server/settings.ts';

// ── Art-Net discovery packets ───────────────────────────────────────────────

test('ArtPoll is a well-formed 14-byte packet', () => {
  const p = buildArtPoll();

  assert.strictEqual(p.length, 14);
  assert.strictEqual(p.subarray(0, 8).toString('ascii'), 'Art-Net\0');
  assert.strictEqual(p.readUInt16LE(8), 0x2000, 'OpPoll');
  assert.strictEqual(p.readUInt16BE(10), 14, 'protocol version');
  // Bit 1 of TalkToMe means "keep sending me updates", which would leave nodes
  // chattering at us long after the check finished.
  assert.strictEqual(p[12] & 0x02, 0, 'we do not ask for unsolicited replies');
});

/** An ArtPollReply, as a node would send it: `outputs` are its output ports' SwOut nibbles. */
function fakeReply({
  ip = [192, 168, 1, 50], net = 0, sub = 0, outputs = [3], shortName = 'DMX-1', longName = 'Node One', bindIndex = 1,
} = {}) {
  const buf = Buffer.alloc(239);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x2100, 8);
  ip.forEach((octet, i) => { buf[10 + i] = octet; });
  buf.writeUInt16LE(6454, 14);
  buf[18] = net;
  buf[19] = sub;
  buf.write(shortName, 26, 18, 'latin1');
  buf.write(longName, 44, 64, 'latin1');
  buf.writeUInt16BE(outputs.length, 172);
  outputs.forEach((swOut, i) => {
    buf[174 + i] = 0x80;                 // this port outputs DMX from the network
    buf[190 + i] = swOut;
  });
  [0x00, 0x11, 0x22, 0x33, 0x44, 0x55].forEach((b, i) => { buf[201 + i] = b; });
  buf[211] = bindIndex;
  return buf;
}

test('an ArtPollReply yields the node identity worth showing an operator', () => {
  const reply = parseArtPollReply(fakeReply());

  assert.strictEqual(reply.address, '192.168.1.50');
  assert.strictEqual(reply.port, 6454);
  assert.strictEqual(reply.shortName, 'DMX-1');
  assert.strictEqual(reply.longName, 'Node One');
  assert.strictEqual(reply.universe, 3);
  assert.deepStrictEqual(reply.outputs, [3]);
  assert.strictEqual(reply.mac, '00:11:22:33:44:55');
  assert.strictEqual(reply.bindIndex, 1);
});

// A port's universe is its port-address: 7 bits of net, 4 of subnet, and 4
// of universe that each port sets for itself. The old reading ran the net and
// subnet bytes together and ignored the port, so a node on subnet 1 was listed
// on universe 1 when it was listening to 16.
test('each output port\'s universe combines the net, the subnet and its own nibble', () => {
  assert.deepStrictEqual(parseArtPollReply(fakeReply({ net: 1, sub: 2, outputs: [0] })).outputs, [256 + 32]);
  assert.deepStrictEqual(parseArtPollReply(fakeReply({ sub: 1, outputs: [0, 1, 2, 3] })).outputs, [16, 17, 18, 19]);
});

test('ports that do not output DMX are not listed', () => {
  const buf = fakeReply({ outputs: [0, 1] });
  buf[175] = 0x40;                       // port 2 is an input
  assert.deepStrictEqual(parseArtPollReply(buf).outputs, [0]);
});

test('anything that is not an ArtPollReply is rejected rather than misread', () => {
  assert.strictEqual(parseArtPollReply(Buffer.alloc(239)), null, 'no Art-Net header');
  assert.strictEqual(parseArtPollReply(buildArtPoll()), null, 'a poll is not a reply');
  assert.strictEqual(parseArtPollReply(Buffer.alloc(10)), null, 'too short');
  assert.strictEqual(parseArtPollReply(null), null);
});

// ── Patch check ─────────────────────────────────────────────────────────────

function withFixtures(fixtures, fn) {
  const original = state.fixtures;
  state.fixtures = fixtures;
  try { return fn(); } finally { state.fixtures = original; }
}

const fixture = (over) => ({
  id: 0, label: 'PAR', address: 1, universe: 0, profileId: 'cameo-root-par-6-12ch', override: null, ...over,
});

test('a clean patch passes', () => {
  const result = withFixtures([
    fixture({ id: 0, address: 1 }),
    fixture({ id: 1, address: 13 }),
  ], checkPatch);

  assert.strictEqual(result.status, STATUSES.OK);
});

test('overlapping addresses on one universe are a failure', () => {
  const result = withFixtures([
    fixture({ id: 0, label: 'A', address: 1 }),
    fixture({ id: 1, label: 'B', address: 5 }),
  ], checkPatch);

  assert.strictEqual(result.status, STATUSES.FAIL);
  assert.ok(result.detail);
});

// The same address on two universes is two different wires, and flagging it
// would make multi-universe rigs unusable.
test('the same address on different universes is not a conflict', () => {
  const result = withFixtures([
    fixture({ id: 0, label: 'A', address: 1, universe: 0 }),
    fixture({ id: 1, label: 'B', address: 1, universe: 1 }),
  ], checkPatch);

  assert.strictEqual(result.status, STATUSES.OK);
});

test('a fixture running past the end of its universe is a failure', () => {
  const result = withFixtures([fixture({ label: 'Tail', address: 510 })], checkPatch);

  assert.strictEqual(result.status, STATUSES.FAIL);
  assert.ok(result.detail);
});

// ── sACN check ──────────────────────────────────────────────────────────────

function withSacn(config, fn) {
  const before = output.getSacnConfig();
  const universe = state.artnet.universe;
  const fixtureUniverses = state.fixtures.map((fixture) => fixture.universe);
  state.artnet.universe = 0;
  state.fixtures.forEach((fixture) => { fixture.universe = 0; });
  output.configureSacn(config);
  try { return fn(); } finally {
    output.configureSacn(before);
    state.artnet.universe = universe;
    state.fixtures.forEach((fixture, index) => { fixture.universe = fixtureUniverses[index]; });
  }
}

test('sACN turned off is reported, not treated as a problem', () => {
  const result = withSacn({ enabled: false }, checkSacn);
  assert.strictEqual(result.status, STATUSES.INFO);
});

test('an enabled sACN output spells out where each universe goes', () => {
  const result = withSacn({ enabled: true, universeOffset: 1, host: '', priority: 100, sourceName: 'Rig' }, checkSacn);

  assert.strictEqual(result.status, STATUSES.OK);
  assert.ok(result.detail);
});

// An offset that pushes a universe out of the legal E1.31 range means those
// frames are silently dropped, which is exactly the failure preflight exists
// to catch before the show rather than during it.
test('a universe that maps outside the sACN range is a failure', () => {
  const result = withSacn({ enabled: true, universeOffset: 0, host: '', priority: 100, sourceName: 'Rig' }, checkSacn);

  assert.strictEqual(result.status, STATUSES.FAIL);
  assert.ok(result.detail);
});

// ── Other checks ────────────────────────────────────────────────────────────

test('the PANNs check reports a status and a way out', () => {
  const result = checkPanns();

  assert.ok([STATUSES.OK, STATUSES.WARN].includes(result.status),
    'a missing model is a warning, never a failure — the analyser degrades to a mood palette');
  if (result.status === STATUSES.WARN) assert.ok(result.fix, 'and says how to fix it');
});

test('a loopback bind with no token is reported as safe rather than open', () => {
  const result = checkAccess();
  assert.ok([STATUSES.INFO, STATUSES.OK].includes(result.status));
});

test('no MIDI controller configured is information, not a warning', (t) => {
  const originalGet = settings.get.bind(settings);
  t.mock.method(settings, 'get', (key) => key === 'midi.input' ? '' : originalGet(key));
  const result = checkMidi({ enabled: false, listPorts: () => ({ inputs: [], outputs: [] }) });
  assert.strictEqual(result.status, STATUSES.INFO);
});

test('a connected controller passes', () => {
  const result = checkMidi({ enabled: true, listPorts: () => ({ inputs: ['X-TOUCH'], outputs: [] }) });
  assert.strictEqual(result.status, STATUSES.OK);
});

test('a missing binary is reported by name rather than as a stack trace', async () => {
  const result = await probeCommand('definitely-not-a-real-binary-xyz', ['--version']);

  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});

test('a working binary reports its first line of output', async () => {
  const result = await probeCommand(process.execPath, ['--version']);

  assert.strictEqual(result.ok, true);
  assert.match(result.version, /^v\d+\./);
});

// ── Philips Hue ─────────────────────────────────────────────────────────────
// The checks that matter here are the ones that fail silently at show time: a
// lamp patched on a channel the area no longer has, a gradient lamp whose
// sections were changed, two lamps on one channel, or lamps in the patch with
// the output off. None reaches the bridge as an error — the lamp just never
// lights, or lights wrong.

import { registerProfile } from '../../src/server/profiles.ts';
import { HUE_COLOR, HUE_GRADIENT } from './hue-test-lamps.js';

registerProfile(HUE_COLOR);
registerProfile(HUE_GRADIENT);

const lamp = (id, channels, profile = HUE_COLOR, bridge = 'b1') => ({
  id, label: `Lamp ${id}`, address: 1, universe: 60000, profileId: profile.id, maxBrightness: 255, override: null,
  output: { protocol: 'hue', bridge, channels: Array.isArray(channels) ? channels : [channels] },
});
/** The paired bridge's area, as hue.ts lists it: a bulb on 0 and a strip on 3–7. */
const AREA_LAMPS = [
  { id: 'bulb', name: 'Shelf', product: 'Hue color lamp', devices: ['d0'], channels: [0], kind: 'color', capabilities: null },
  { id: 'strip', name: 'TV', product: 'Hue gradient lightstrip', devices: ['d1'], channels: [3, 4, 5, 6, 7], kind: 'color', capabilities: null },
];
const area = (lamps = AREA_LAMPS) => async () => [{
  id: '0123abcd-1234-5678-9abc-def012345678', name: 'Living room', status: 'inactive',
  channels: lamps.flatMap((l) => l.channels.map((id) => ({ id }))), lamps,
}];
const OFF = { id: 'b1', label: 'Lounge', enabled: false, host: '', username: '', clientKey: '', applicationId: '', entertainmentId: '' };
const PAIRED = {
  ...OFF, enabled: true, host: '10.0.0.9', username: 'key', clientKey: 'aabb', entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
};

/** Run the Hue check with these bridges and these lamps in the patch, then put both back. */
async function withHue(bridges, fn, lamps = []) {
  const before = output.getHueConfig();
  const fixtures = state.fixtures;
  try {
    output.configureHue({ bridges });
    state.fixtures = [...fixtures.filter((f) => !f.output), ...lamps];
    return await fn();
  } finally {
    state.fixtures = fixtures;
    output.configureHue({ bridges: before.bridges, latencyMs: before.latencyMs });
  }
}

test('no bridge paired is information, not a warning', async () => {
  const [check, ...rest] = await withHue([], () => checkHue());
  assert.strictEqual(check.status, STATUSES.INFO);
  assert.strictEqual(rest.length, 0);
});

test('Hue lamps in the patch with no bridge paired are a warning', async () => {
  const [check] = await withHue([], () => checkHue(), [lamp(90, 0)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /no bridge is paired/);
});

test('a bridge that is off is information; off with its lamps in the patch is a warning', async () => {
  const [off] = await withHue([OFF], () => checkHue());
  assert.strictEqual(off.status, STATUSES.INFO);
  const [check] = await withHue([OFF], () => checkHue(), [lamp(90, 0)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.ok(check.detail);
});

test('a bridge that is on with no pairing names what is missing, and which bridge', async () => {
  const [check] = await withHue([{ ...OFF, enabled: true, host: '10.0.0.9' }], () => checkHue());
  assert.strictEqual(check.status, STATUSES.FAIL);
  assert.strictEqual(check.id, 'hue:b1');
  assert.match(check.label, /Lounge/);
  assert.match(check.detail, /pairing/);
  assert.match(check.detail, /entertainment area/);
  assert.ok(check.fix, 'a failure says what to do about it');
});

test('a paired bridge with no lamp in the patch warns rather than passing', async () => {
  const [check] = await withHue([PAIRED], () => checkHue());
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /none of its lamps is in the patch/);
});

// Only one of them can be shown, and nothing else would say so.
test('two lamps on one channel of one bridge are a warning, before the bridge is contacted', async () => {
  const [check] = await withHue([{ ...PAIRED, host: 'bridge.invalid' }], () => checkHue(),
    [lamp(90, [3, 4, 5, 6, 7], HUE_GRADIENT), lamp(91, 5)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /both on channel 5 of "Lounge"/);
});

test('the same channel on two bridges is two lamps, not a clash', async () => {
  const bridges = [PAIRED, { ...PAIRED, id: 'b2', label: 'Party' }];
  const checks = await withHue(bridges, () => checkHue(area()), [lamp(90, 0), lamp(91, 0, HUE_COLOR, 'b2')]);
  assert.deepStrictEqual(checks.map((c) => [c.id, c.status]), [['hue:b1', STATUSES.OK], ['hue:b2', STATUSES.OK]]);
});

test('every lamp on the area\'s channels, sections and all, passes', async () => {
  const [check] = await withHue([PAIRED], () => checkHue(area()), [lamp(90, 0), lamp(91, [3, 4, 5, 6, 7], HUE_GRADIENT)]);
  assert.strictEqual(check.status, STATUSES.OK, check.detail);
  assert.match(check.detail, /Lamp 90, Lamp 91/);
});

test('a lamp on a channel the area does not have is a warning naming it', async () => {
  const [check] = await withHue([PAIRED], () => checkHue(area()), [lamp(90, 9)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /no channel #9 for "Lamp 90"/);
});

// The Hue app can split a gradient lamp into other sections: the patch still
// sends the old channels, so some of the lamp shows the wrong part of the show.
test('a gradient lamp whose sections changed in the Hue app is a warning', async () => {
  const resplit = [AREA_LAMPS[0], { ...AREA_LAMPS[1], channels: [3, 4, 5, 6, 7, 8] }];
  const [check] = await withHue([PAIRED], () => checkHue(area(resplit)), [lamp(91, [3, 4, 5, 6, 7], HUE_GRADIENT)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /"Lamp 91" has different sections/);
});

// An unreachable bridge must be reported as such rather than throwing out of
// the whole preflight run — and as a warning that names it: the rest of the
// rig, and any other bridge, still runs.
test('a bridge that cannot be reached is a warning naming it, with the reason attached', async () => {
  const [check] = await withHue([{
    ...PAIRED,
    // .invalid is reserved by RFC 2606 and is guaranteed never to resolve, so
    // this fails on DNS immediately. An unroutable IP would test the same path
    // but spend the full REST timeout doing it, on every run of the suite.
    host: 'bridge.invalid',
  }], () => checkHue(), [lamp(90, 0)]);
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /Cannot reach "Lounge" at bridge\.invalid/);
});

test('every bridge is checked, each a row of its own, and a lamp of a bridge that is gone is called out', async () => {
  const bridges = [{ ...PAIRED, host: 'bridge.invalid' }, { ...OFF, id: 'b2', label: 'Party' }];
  const checks = await withHue(bridges, () => checkHue(), [lamp(90, 0), lamp(91, 0, HUE_COLOR, 'b2'), lamp(92, 0, HUE_COLOR, 'gone')]);
  assert.deepStrictEqual(checks.map((c) => [c.id, c.status]), [['hue:b1', STATUSES.WARN], ['hue:b2', STATUSES.WARN], ['hue', STATUSES.WARN]]);
  assert.match(checks[0].detail, /"Lounge"/);
  assert.match(checks[1].detail, /output is off/);
  assert.match(checks[2].detail, /"Lamp 92" \(bridge gone\)/);
});

// Model weights run to gigabytes: the check fetches what is missing in the
// background through the model manager, once — see model-manager.test.js.

// ── Engine ──────────────────────────────────────────────────────────────────

import { checkEngine } from '../../src/server/preflight.ts';

const timing = { frames: 2640, rate: 44, renderMs: { p50: 0.2, p95: 0.8, max: 3 }, lateMs: { p50: 0, p95: 0.4, max: 2 } };

test('an engine on its own thread, on time, passes', () => {
  const r = checkEngine({ thread: 'worker', fellBack: null, lateFrames: 0, skippedFrames: 0, ...timing });
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.detail);
});

test('dropped frames, or many late ones, are a warning with the fix for where it runs', () => {
  const onMain = checkEngine({ thread: 'main', fellBack: null, lateFrames: 3, skippedFrames: 9, ...timing });
  assert.strictEqual(onMain.status, 'warn');
  assert.ok(onMain.detail);
  assert.ok(onMain.fix);
  const onWorker = checkEngine({ thread: 'worker', fellBack: null, lateFrames: 40, skippedFrames: 0, ...timing });
  assert.strictEqual(onWorker.status, 'warn', 'forty of 2,640 is more than one in a hundred');
  assert.ok(onWorker.fix);
});

test('the odd frame a little late is noted, not warned about', () => {
  const r = checkEngine({ thread: 'worker', fellBack: null, lateFrames: 1, skippedFrames: 0, ...timing });
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.detail);
});

test('an engine that fell back to the main thread says why', () => {
  const r = checkEngine({ thread: 'main', fellBack: 'the engine thread could not start (exit 1)', lateFrames: 0, skippedFrames: 0, ...timing });
  assert.strictEqual(r.status, 'warn');
  assert.ok(r.detail);
});

test('an engine that is not running fails', () => {
  assert.strictEqual(checkEngine({ thread: null }).status, 'fail');
});

test('run on its own, before the server, there is no engine to report on', () => {
  const r = checkEngine({ thread: null }, { standalone: true });
  assert.strictEqual(r.status, 'info');
  assert.ok(r.detail);
});
