'use strict';

const test = require('node:test');
const assert = require('node:assert');

const hue = require('../../src/server/hue');
const { nameChannel } = hue;

// ── Packet layout ───────────────────────────────────────────────────────────
// A byte out of place here does not fail loudly: the bridge accepts the packet
// and lights the wrong lamp, or nothing at all.

const AREA = '0123abcd-1234-5678-9abc-def012345678';

test('a stream message is header + area id + 7 bytes per channel', () => {
  const packet = hue.buildStreamMessage(AREA, [
    { id: 0, r: 0, g: 0, b: 0 },
    { id: 1, r: 0, g: 0, b: 0 },
  ]);
  assert.strictEqual(packet.length, 16 + 36 + 2 * 7);
});

test('the header names the protocol and version the bridge expects', () => {
  const packet = hue.buildStreamMessage(AREA, [{ id: 0, r: 1, g: 2, b: 3 }]);
  assert.strictEqual(packet.subarray(0, 9).toString('ascii'), 'HueStream');
  assert.strictEqual(packet[9], 2, 'major version');
  assert.strictEqual(packet[10], 0, 'minor version');
  assert.strictEqual(packet[14], 0, 'RGB colour space, not xy');
});

// The area id is a fixed 36-byte field. A short one would shift every channel
// after it, which is the kind of bug that looks like "the mapping is wrong".
test('the area id occupies exactly 36 bytes', () => {
  const packet = hue.buildStreamMessage(AREA, []);
  assert.strictEqual(packet.subarray(16, 52).toString('ascii'), AREA);
  assert.strictEqual(packet.length, 52);
});

test('a short area id is padded rather than shifting the channels', () => {
  const packet = hue.buildStreamMessage('short', [{ id: 9, r: 255, g: 0, b: 0 }]);
  assert.strictEqual(packet.length, 52 + 7);
  assert.strictEqual(packet[52], 9, 'the channel id still starts at byte 52');
});

test('channels carry a byte id and three 16-bit primaries', () => {
  const packet = hue.buildStreamMessage(AREA, [{ id: 7, r: 255, g: 128, b: 0 }]);
  assert.strictEqual(packet[52], 7);
  assert.strictEqual(packet.readUInt16BE(53), 65535, 'red at full');
  assert.strictEqual(packet.readUInt16BE(55), 128 * 257);
  assert.strictEqual(packet.readUInt16BE(57), 0);
});

test('several channels are laid out back to back in order', () => {
  const packet = hue.buildStreamMessage(AREA, [
    { id: 3, r: 255, g: 0, b: 0 },
    { id: 4, r: 0, g: 255, b: 0 },
  ]);
  assert.strictEqual(packet[52], 3);
  assert.strictEqual(packet.readUInt16BE(53), 65535);
  assert.strictEqual(packet[59], 4, 'second channel starts 7 bytes on');
  assert.strictEqual(packet.readUInt16BE(62), 65535, 'its green');
});

// ── Colour widening ─────────────────────────────────────────────────────────
// ×257 rather than <<8: the naive shift can never reach full output, so a rig
// at 100% would sit a step below the Hue app's own maximum.
test('8-bit colour widens to the full 16-bit range', () => {
  assert.strictEqual(hue.to16(0), 0);
  assert.strictEqual(hue.to16(255), 65535);
  assert.strictEqual(hue.to16(128), 32896);
});

test('out-of-range colour is clamped rather than wrapping', () => {
  assert.strictEqual(hue.to16(-5), 0);
  assert.strictEqual(hue.to16(300), 65535);
  assert.strictEqual(hue.to16(undefined), 0);
});

// ── Configuration ───────────────────────────────────────────────────────────

test('a session is only considered configured once every credential is present', () => {
  assert.strictEqual(hue.isConfigured({ host: '10.0.0.2', username: 'u', clientKey: 'ab', entertainmentId: 'x' }), true);
  assert.strictEqual(hue.isConfigured({ host: '', username: 'u', clientKey: 'ab', entertainmentId: 'x' }), false);
  assert.strictEqual(hue.isConfigured({ host: '10.0.0.2', username: '', clientKey: 'ab', entertainmentId: 'x' }), false);
  assert.strictEqual(hue.isConfigured({ host: '10.0.0.2', username: 'u', clientKey: '', entertainmentId: 'x' }), false);
  assert.strictEqual(hue.isConfigured({ host: '10.0.0.2', username: 'u', clientKey: 'ab', entertainmentId: '' }), false);
});

test('configure merges over what is already set', () => {
  try {
    hue.configure({ host: '10.0.0.2', username: 'user', clientKey: 'aabb' });
    hue.configure({ entertainmentId: AREA });
    const config = hue.getConfig();
    assert.strictEqual(config.host, '10.0.0.2', 'untouched keys survive');
    assert.strictEqual(config.entertainmentId, AREA);
  } finally {
    hue._reset();
  }
});

// Nothing may be sent before there is somewhere to send it: an unconfigured
// bridge must not have the render loop opening sockets 40 times a second.
test('an unconfigured or disabled session sends nothing', () => {
  try {
    assert.strictEqual(hue.sendFrame([{ id: 0, r: 255, g: 0, b: 0 }]), false);
    hue.configure({ enabled: true, host: '10.0.0.2', username: 'user', clientKey: 'aabb' });
    assert.strictEqual(hue.sendFrame([{ id: 0, r: 255, g: 0, b: 0 }]), false, 'no area picked');
  } finally {
    hue._reset();
  }
});

test('a fresh session reports itself idle and unconfigured', () => {
  hue._reset();
  const status = hue.getStatus();
  assert.strictEqual(status.status, 'idle');
  assert.strictEqual(status.configured, false);
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.error, null);
});

// Opening a session puts the area into entertainment mode, which takes those
// lamps out of normal Hue control. Doing that with nothing bound seizes them
// and then sends no colours, so the lamps are held hostage for no benefit.
test('a fully paired session with no bindings never contacts the bridge', () => {
  try {
    hue.configure({
      enabled: true, host: '10.0.0.2', username: 'user', clientKey: 'aabb',
      entertainmentId: AREA,
    });
    assert.strictEqual(hue.isConfigured(), true, 'everything is set up');
    assert.strictEqual(hue.sendFrame([]), false);
    assert.strictEqual(hue.getStatus().status, 'idle', 'no connection was attempted');
  } finally {
    hue._reset();
  }
});

// ── Protocol limits ─────────────────────────────────────────────────────────
// One stream message carries at most 20 channel slots. That is the protocol's
// limit rather than a suggestion — a longer message is malformed — and an
// entertainment area cannot hold more than 20 lights either.

test('the protocol maximum is 20 channel slots', () => {
  assert.strictEqual(hue.MAX_CHANNELS, 20);
});

test('a full 20-channel message is the largest legal size', () => {
  const channels = Array.from({ length: 20 }, (_, i) => ({ id: i, r: 0, g: 0, b: 0 }));
  const packet = hue.buildStreamMessage(AREA, channels);
  assert.strictEqual(packet.length, 16 + 36 + 20 * 7);
  assert.strictEqual(packet.length, 192);
});

// The DTLS identity is the bridge's application id, not the application key
// they are issued alongside. A bridge that cannot answer /auth/v1 is one that
// still accepts the key, so this must degrade rather than throw.
test('an unreachable bridge yields no application id rather than an error', async () => {
  const id = await hue.fetchApplicationId('bridge.invalid', 'some-key');
  assert.strictEqual(id, null);
});

// ── Lamp names ──────────────────────────────────────────────────────────────
// A channel carries no name of its own, only the services that render it. The
// name a person recognises lives on the device that owns the service, so
// binding by channel number alone meant counting round the room to work out
// which lamp "#3" was.

const LAMP_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const LAMP_B = 'bbbbbbbb-0000-0000-0000-000000000002';

function channelOf(...rids) {
  return { members: rids.map((rid, index) => ({ service: { rtype: 'entertainment', rid }, index })) };
}

test('a channel takes the name of the lamp that renders it', () => {
  const names = new Map([[LAMP_A, { name: 'Right', product: 'Hue color spot' }]]);
  const counts = new Map([[LAMP_A, 1]]);
  assert.strictEqual(nameChannel(channelOf(LAMP_A), names, counts, new Map()), 'Right');
});

// A gradient strip or Play bar spreads several channels over one device. Three
// rows all called "Strip" give no way to tell which end you are binding.
test('a lamp rendering several channels has them numbered in order', () => {
  const names = new Map([[LAMP_A, { name: 'Strip', product: 'Hue gradient strip' }]]);
  const counts = new Map([[LAMP_A, 3]]);
  const seen = new Map();
  assert.strictEqual(nameChannel(channelOf(LAMP_A), names, counts, seen), 'Strip 1');
  assert.strictEqual(nameChannel(channelOf(LAMP_A), names, counts, seen), 'Strip 2');
  assert.strictEqual(nameChannel(channelOf(LAMP_A), names, counts, seen), 'Strip 3');
});

test('two lamps on one channel are both named', () => {
  const names = new Map([
    [LAMP_A, { name: 'Left', product: '' }],
    [LAMP_B, { name: 'Right', product: '' }],
  ]);
  const counts = new Map([[LAMP_A, 1], [LAMP_B, 1]]);
  assert.strictEqual(nameChannel(channelOf(LAMP_A, LAMP_B), names, counts, new Map()), 'Left + Right');
});

// Two members of one channel are two halves of one fitting; "Strip + Strip"
// says nothing that "Strip" does not.
test('one lamp listed twice on a channel is named once', () => {
  const names = new Map([[LAMP_A, { name: 'Bar', product: '' }]]);
  const counts = new Map([[LAMP_A, 1]]);
  assert.strictEqual(nameChannel(channelOf(LAMP_A, LAMP_A), names, counts, new Map()), 'Bar');
});

// Names are a convenience; the channel ids are the truth. A bridge that will
// not answer the extra lookups should cost a plainer table, not an error.
test('a channel whose lamp could not be named comes back blank, not broken', () => {
  assert.strictEqual(nameChannel(channelOf(LAMP_A), new Map(), new Map(), new Map()), '');
  assert.strictEqual(nameChannel({}, new Map(), new Map(), new Map()), '');
});

test('lamp names from an unreachable bridge are empty rather than an error', async () => {
  const names = await hue.fetchLampNames('bridge.invalid', 'key');
  assert.strictEqual(names.size, 0);
});
