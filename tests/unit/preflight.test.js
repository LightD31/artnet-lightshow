'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../../src/server/state');
const output = require('../../src/server/output');
const {
  checkPatch, checkSacn, checkPanns, checkAccess, checkMidi, probeCommand, STATUSES,
} = require('../../src/server/preflight');
const { buildArtPoll, parseArtPollReply } = require('../../src/server/artnet');

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

/** A minimal ArtPollReply, as a node would send it. */
function fakeReply({ ip = [192, 168, 1, 50], net = 0, sub = 3, shortName = 'DMX-1', longName = 'Node One' } = {}) {
  const buf = Buffer.alloc(239);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x2100, 8);
  ip.forEach((octet, i) => { buf[10 + i] = octet; });
  buf.writeUInt16LE(6454, 14);
  buf[18] = net;
  buf[19] = sub;
  buf.write(shortName, 26, 18, 'latin1');
  buf.write(longName, 44, 64, 'latin1');
  return buf;
}

test('an ArtPollReply yields the node identity worth showing an operator', () => {
  const reply = parseArtPollReply(fakeReply());

  assert.strictEqual(reply.address, '192.168.1.50');
  assert.strictEqual(reply.port, 6454);
  assert.strictEqual(reply.shortName, 'DMX-1');
  assert.strictEqual(reply.longName, 'Node One');
  assert.strictEqual(reply.universe, 3);
});

test('the reply universe combines the net and subnet bytes', () => {
  assert.strictEqual(parseArtPollReply(fakeReply({ net: 1, sub: 2 })).universe, 258);
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
  output.configureSacn(config);
  try { return fn(); } finally { output.configureSacn(before); }
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

test('no MIDI controller configured is information, not a warning', () => {
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
