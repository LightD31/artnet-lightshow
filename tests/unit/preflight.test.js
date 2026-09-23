'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const output = require('../../src/server/output');
const {
  checkPatch, checkSacn, checkHue, checkPanns, checkAccess, checkMidi, probeCommand, STATUSES,
} = require('../../src/server/preflight');
const { buildArtPoll, parseArtPollReply } = require('../../src/server/artnet');
const { settings } = require('../../src/server/settings');

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
  assert.match(result.detail, /"A" and "B" overlap/);
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
  assert.match(result.detail, /past the 512-channel universe/);
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
  assert.match(result.detail, /multicast/);
  assert.match(result.detail, /0→1/);
});

// An offset that pushes a universe out of the legal E1.31 range means those
// frames are silently dropped, which is exactly the failure preflight exists
// to catch before the show rather than during it.
test('a universe that maps outside the sACN range is a failure', () => {
  const result = withSacn({ enabled: true, universeOffset: 0, host: '', priority: 100, sourceName: 'Rig' }, checkSacn);

  assert.strictEqual(result.status, STATUSES.FAIL);
  assert.match(result.detail, /outside the 1–63999 sACN range/);
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
  assert.strictEqual(result.error, 'not found on PATH');
});

test('a working binary reports its first line of output', async () => {
  const result = await probeCommand(process.execPath, ['--version']);

  assert.strictEqual(result.ok, true);
  assert.match(result.version, /^v\d+\./);
});

// ── Philips Hue ─────────────────────────────────────────────────────────────
// The checks that matter here are the ones that fail silently at show time: a
// binding pointing at a deleted fixture, or an area that was rebuilt in the Hue
// app. Neither reaches the bridge as an error — the lamp just never lights.

/** Run a Hue check with a given config, then put the old one back. */
async function withHue(config, fn) {
  const before = output.getHueConfig();
  try {
    output.configureHue({
      enabled: false, host: '', username: '', clientKey: '', entertainmentId: '', channels: [],
      ...config,
    });
    return await fn();
  } finally {
    output.configureHue({ ...before });
  }
}

test('Hue output that is off is information, not a warning', async () => {
  const check = await withHue({ enabled: false }, () => checkHue());
  assert.strictEqual(check.status, STATUSES.INFO);
});

test('Hue output enabled with no pairing names what is missing', async () => {
  const check = await withHue({ enabled: true, host: '10.0.0.9' }, () => checkHue());
  assert.strictEqual(check.status, STATUSES.FAIL);
  assert.match(check.detail, /pairing/);
  assert.match(check.detail, /entertainment area/);
  assert.ok(check.fix, 'a failure says what to do about it');
});

test('a paired bridge with nothing bound warns rather than passing', async () => {
  const check = await withHue({
    enabled: true, host: '10.0.0.9', username: 'key', clientKey: 'aabb',
    entertainmentId: '0123abcd-1234-5678-9abc-def012345678', channels: [],
  }, () => checkHue());
  assert.strictEqual(check.status, STATUSES.WARN);
  assert.match(check.detail, /no Hue channel/);
});

// The failure this exists to catch: delete a fixture, and the Hue channel bound
// to it stops being sent. On the night that looks like a dead lamp.
test('a binding pointing at a deleted fixture is a failure, before the bridge is contacted', async () => {
  const check = await withHue({
    enabled: true, host: '10.0.0.9', username: 'key', clientKey: 'aabb',
    entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
    channels: [{ channel: 0, fixture: 4242 }],
  }, () => checkHue());
  assert.strictEqual(check.status, STATUSES.FAIL);
  assert.match(check.detail, /no longer in the patch/);
});

// An unreachable bridge must be reported as such rather than throwing out of
// the whole preflight run.
test('a bridge that cannot be reached is a failure with the reason attached', async () => {
  const check = await withHue({
    enabled: true,
    // .invalid is reserved by RFC 2606 and is guaranteed never to resolve, so
    // this fails on DNS immediately. An unroutable IP would test the same path
    // but spend the full REST timeout doing it, on every run of the suite.
    host: 'bridge.invalid', username: 'key', clientKey: 'aabb',
    entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
    channels: [{ channel: 0, fixture: state.fixtures[0].id }],
  }, () => checkHue());
  assert.strictEqual(check.status, STATUSES.FAIL);
  assert.match(check.detail, /Cannot reach the bridge/);
});

// Model weights run to gigabytes. The server's check used to download them
// with spawnSync — Art-Net output frozen for the whole download, and a new
// download on every run that found them missing.
test('missing model weights are fetched in the background, once',
  { skip: process.platform === 'win32' && 'uses a POSIX shell stand-in' }, async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { checkAnalysisModels, _modelDownload } = require('../../src/server/preflight');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
    const calls = path.join(dir, 'calls.log');
    const fake = path.join(dir, 'fake-python');
    fs.writeFileSync(fake, `#!/bin/sh\necho run >> "${calls}"\nsleep 0.3\nexit 0\n`, { mode: 0o755 });
    const saved = { dir: process.env.ARTNET_MODEL_DIR, py: process.env.ARTNET_PYTHON };
    process.env.ARTNET_MODEL_DIR = path.join(dir, 'empty');
    process.env.ARTNET_PYTHON = fake;
    const log = console.log;
    console.log = () => {};
    try {
      const started = Date.now();
      const first = checkAnalysisModels({ download: true });
      assert.ok(Date.now() - started < 200, 'did not wait for the download');
      assert.match(first.detail, /background/);
      const second = checkAnalysisModels({ download: true });
      assert.match(second.detail, /background/);

      await _modelDownload().promise;
      // Finished without error but the weights are still not all there: say
      // so, and do not start the same download again.
      const after = checkAnalysisModels({ download: true });
      assert.doesNotMatch(after.detail, /background/);
      assert.strictEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'one download');
    } finally {
      console.log = log;
      if (saved.dir === undefined) delete process.env.ARTNET_MODEL_DIR; else process.env.ARTNET_MODEL_DIR = saved.dir;
      if (saved.py === undefined) delete process.env.ARTNET_PYTHON; else process.env.ARTNET_PYTHON = saved.py;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
