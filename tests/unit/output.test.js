import test from 'node:test';
import assert from 'node:assert';

import * as output from '../../src/server/output.ts';

// Art-Net counts universes from 0, sACN from 1. Getting the offset wrong sends
// every fixture one universe away from where the console is listening.
test('the default offset lines Art-Net universe 0 up with sACN universe 1', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 1), 1);
  assert.strictEqual(output.sacnUniverseFor(7, 1), 8);
});

test('an offset can map the rig anywhere in the sACN range', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 100), 100);
  assert.strictEqual(output.sacnUniverseFor(5, -4), 1);
});

// Universe 0 is reserved in E1.31 and 64000+ does not exist, so a frame that
// would land there is dropped rather than sent somewhere it does not belong.
test('a universe outside the E1.31 range maps to nothing', () => {
  assert.strictEqual(output.sacnUniverseFor(0, 0), null, 'sACN has no universe 0');
  assert.strictEqual(output.sacnUniverseFor(0, -1), null);
  assert.strictEqual(output.sacnUniverseFor(32767, 63999), null, 'past 63999');
});

test('configureSacn merges over the defaults and reads back', () => {
  const before = output.getSacnConfig();
  try {
    output.configureSacn({ enabled: true, priority: 200 });
    const config = output.getSacnConfig();
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.priority, 200);
    assert.strictEqual(config.sourceName, before.sourceName, 'untouched keys survive');
  } finally {
    output.configureSacn(before);
  }
});

// ── Hue lamps ───────────────────────────────────────────────────────────────
// A Hue lamp is a fixture of its own with no DMX address, patched as one
// channel of the entertainment area. It is rendered like any other fixture,
// and its channel takes its colour from the rendered universe rather than from
// the engine's intermediate values. That is what makes a Hue lamp obey the
// dimmer, the trim, the master and blackout for free — so these tests read
// the buffer the same way the real path does.

import * as universes from '../../src/server/universes.ts';
import { state, universeOf, placeAddresslessFixtures } from '../../src/server/state.ts';
import { BUILTIN_PROFILE_ID, HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID, HUE_WHITE_AMBIANCE_PROFILE_ID, getProfile } from '../../src/server/profiles.ts';
import dgram from 'node:dgram';

/**
 * Run `fn` on a patch of these lamps — `{ channel, profileId }`, or `{ par }`
 * for a DMX par among them — each rendered into a clean frame. `fn` gets
 * `set(index, attribute, value)`, which writes one channel of a fixture the
 * way the engine would.
 */
function withLamps(lamps, fn) {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  state.fixtures = lamps.map((lamp, i) => (lamp.par
    ? { id: 100 + i, label: `Par ${i}`, address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null }
    : {
      id: 100 + i, label: `Lamp ${i}`, address: 1, universe: 0, profileId: lamp.profileId ?? HUE_COLOR_PROFILE_ID,
      maxBrightness: 255, override: null, output: { protocol: 'hue', channel: lamp.channel },
    }));
  placeAddresslessFixtures();
  const clean = () => { for (const fix of state.fixtures) universes.getBuffer(universeOf(fix)).fill(0); };
  const set = (index, attribute, value) => {
    const fix = state.fixtures[index];
    universes.getBuffer(universeOf(fix))[fix.address - 1 + getProfile(fix).channelMap[attribute]] = value;
  };
  clean();
  try {
    return fn(set);
  } finally {
    clean();
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
  }
}

test('a lamp\'s channel takes the colour it was rendered', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'red', 180); set(0, 'green', 90); set(0, 'blue', 20);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 180, g: 90, b: 20 }]);
  });
});

test('each lamp is sent on its own channel, in patch order', () => {
  withLamps([{ channel: 5 }, { channel: 2 }], (set) => {
    set(0, 'red', 20);
    set(1, 'red', 10);
    assert.deepStrictEqual(output.hueChannelColors().map((c) => [c.id, c.r]), [[5, 20], [2, 10]]);
  });
});

// Only a Hue lamp reaches the bridge: a par has no Hue channel, and no Hue
// channel can be pointed at one.
test('a par in the patch is never sent to the bridge', () => {
  withLamps([{ par: true }, { channel: 3 }], (set) => {
    set(0, 'red', 255);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 3, r: 0, g: 0, b: 0 }]);
  });
});

test('two lamps on one channel: the first in the patch is shown', () => {
  withLamps([{ channel: 1 }, { channel: 1 }], (set) => {
    set(0, 'blue', 40); set(1, 'blue', 200);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 1, r: 0, g: 0, b: 40 }]);
  });
});

test('no lamp in the patch means no Hue message at all', () => {
  withLamps([{ par: true }], () => {
    assert.deepStrictEqual(output.hueChannelColors(), []);
  });
});

// Hue cannot emit UV. Dropping it would leave the lamps black through an entire
// UV wash while the pars glowed, which reads as a dead lamp.
test('a UV wash shows as deep violet rather than black', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'uv', 200);
    const [color] = output.hueChannelColors();
    assert.ok(color.b > color.r && color.r > 0, 'violet: blue-dominant but not pure blue');
    assert.strictEqual(color.g, 0);
  });
});

// The colour dies and the whites together can sum past what the lamp can
// show. Clamping each primary on its own would move the hue; scaling all three
// together keeps the colour and gives up brightness instead.
test('an over-full mix is scaled as a whole, keeping its hue', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'red', 255); set(0, 'warmWhite', 255);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 255, g: 84, b: 43 }], 'still a warm red');
  });
});

test('a mix that fits is left exactly as it is', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'red', 100); set(0, 'green', 50); set(0, 'blue', 25);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 100, g: 50, b: 25 }]);
  });
});

// Blackout and the grand master are already applied by the time the frame is
// written, so an all-zero buffer is the whole story.
test('a blacked-out rig sends black to Hue', () => {
  withLamps([{ channel: 0 }], () => {
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
  });
});

// The one that would be easy to get wrong: a white bulb has no colour channels
// at all, so without the fallback it would read as black and the lamp would
// never light.
test('a white lamp lights at its dimmer level, in neutral white', () => {
  withLamps([{ channel: 0, profileId: HUE_WHITE_PROFILE_ID }], (set) => {
    set(0, 'dimmer', 140);
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 140, g: 140, b: 140 }]);
  });
});

test('a white lamp at zero is black rather than stuck on', () => {
  withLamps([{ channel: 0, profileId: HUE_WHITE_PROFILE_ID }], () => {
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
  });
});

// ── The two white dies ──────────────────────────────────────────────────────
// A Hue colour bulb is RGBWW. The Entertainment stream has no white channel, so
// the warm and cool dies fold into the RGB that goes out — at their real colour
// temperature, which is what keeps a warm wash warm.

test('the warm white die folds in warm, not neutral and not orange', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'warmWhite', 255);
    const [color] = output.hueChannelColors();
    assert.strictEqual(color.r, 255);
    assert.ok(color.g < color.r, 'warmer than neutral white');
    assert.ok(color.b > 0, 'but still a white — a tungsten white has blue in it');
    assert.ok(color.b < color.g, 'and warm rather than pink');
  });
});

test('the cool white die folds in near neutral', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'coolWhite', 200);
    const [color] = output.hueChannelColors();
    for (const v of [color.r, color.g, color.b]) {
      assert.ok(Math.abs(v - 200) <= 6, `close to neutral at the same level (got ${v})`);
    }
  });
});

test('warm reads warmer than cool at the same level', () => {
  const read = (attribute) => withLamps([{ channel: 0 }], (set) => {
    set(0, attribute, 255);
    return output.hueChannelColors()[0];
  });
  const warm = read('warmWhite');
  const cool = read('coolWhite');
  assert.ok(warm.b < cool.b, 'less blue is what makes a white read as warm');
  assert.ok(warm.g < cool.g);
});

// A tunable-white lamp has the two white dies but no primaries. The neutral
// fallback keys off having no emitters at all, not off having no primaries —
// otherwise it would add the dimmer on top of the whites and double up.
test('a white ambiance lamp is not also given its dimmer as white', () => {
  withLamps([{ channel: 0, profileId: HUE_WHITE_AMBIANCE_PROFILE_ID }], (set) => {
    set(0, 'dimmer', 255);
    set(0, 'coolWhite', 100);
    const [color] = output.hueChannelColors();
    assert.ok(Math.abs(color.r - 100) <= 4, `the white die alone decides it (got ${color.r})`);
  });
});

// Until a hostname resolves, Art-Net frames are dropped. sendUniverse used to
// report them as sent regardless.
test('an Art-Net frame is only reported sent once its host has an address', () => {
  const before = { ...state.artnet };
  const warn = console.warn;
  console.warn = () => {};              // the failed lookup logs asynchronously
  try {
    Object.assign(state.artnet, { enabled: true, host: 'no-such-node.invalid', port: 9 });
    assert.ok(!output.sendUniverse(0, Buffer.alloc(512)).includes('artnet'), 'an unresolved host sends nothing');

    Object.assign(state.artnet, { host: '127.0.0.1' });
    assert.ok(output.sendUniverse(0, Buffer.alloc(512)).includes('artnet'), 'an address sends');
  } finally {
    Object.assign(state.artnet, before);
    setTimeout(() => { console.warn = warn; }, 50);
  }
});

// ── Hue latency compensation ─────────────────────────────────────────────────
// The pars are held back so they land with the Hue lamps. Checked on the wire:
// a UDP socket stands in for the Art-Net node and records what arrives.

async function artnetCapture(fn) {
  const socket = dgram.createSocket('udp4');
  const got = [];
  socket.on('message', (msg) => got.push({ at: performance.now(), marker: msg[18] }));
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const before = { ...state.artnet };
  const hueBefore = output.getHueConfig();
  Object.assign(state.artnet, { enabled: true, host: '127.0.0.1', port: socket.address().port });
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 40));        // let the last datagrams land
    return got;
  } finally {
    Object.assign(state.artnet, before);
    output.configureHue({ enabled: hueBefore.enabled, latencyMs: hueBefore.latencyMs });
    socket.close();
  }
}

const frameMarked = (marker) => { const f = Buffer.alloc(512); f[0] = marker; return f; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('with Hue on, Art-Net frames go out the configured delay after they were rendered', async () => {
  let start = 0;
  const got = await artnetCapture(async () => {
    output.configureHue({ enabled: true, latencyMs: 80 });
    start = performance.now();
    // A frame every 20 ms for 200 ms, each one marked with its number.
    for (let i = 1; i <= 10; i++) { output.sendUniverse(0, frameMarked(i)); await wait(20); }
  });
  assert.ok(got.length > 0, 'frames still go out');
  assert.ok(got[0].at - start >= 75, `the first frame went out ${Math.round(got[0].at - start)} ms after it was rendered`);
  const markers = got.map((g) => g.marker);
  assert.deepStrictEqual(markers, markers.slice().sort((a, b) => a - b), 'in the order they were rendered');
  assert.ok(Math.max(...markers) < 10, 'and the newest frame is still waiting its turn');
});

test('without Hue, or at zero delay, frames go straight out', async () => {
  for (const config of [{ enabled: false, latencyMs: 80 }, { enabled: true, latencyMs: 0 }]) {
    const got = await artnetCapture(async () => {
      output.configureHue(config);
      output.sendUniverse(0, frameMarked(7));
    });
    assert.deepStrictEqual(got.map((g) => g.marker), [7], JSON.stringify(config));
  }
});

test('a blackout sent immediately does not wait behind the look it replaces', async () => {
  // Shutdown and a universe leaving the patch send one last black frame. Queued
  // behind the delay it would arrive after the process had gone, or not at all.
  const got = await artnetCapture(async () => {
    output.configureHue({ enabled: true, latencyMs: 200 });
    output.sendUniverse(0, frameMarked(5));
    output.sendUniverse(0, frameMarked(0), { immediate: true });
    await wait(250);
    output.sendUniverse(0, frameMarked(9));
  });
  assert.deepStrictEqual(got.map((g) => g.marker), [0], 'only the blackout, and the queued look is dropped');
});

// ── ArtSync on the wire ──────────────────────────────────────────────────────

test('with ArtSync on, each frame is followed by an OpSync to the same node', async () => {
  const socket = dgram.createSocket('udp4');
  const ops = [];
  socket.on('message', (msg) => ops.push(msg.readUInt16LE(8)));
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const before = { ...state.artnet };
  Object.assign(state.artnet, { enabled: true, host: '127.0.0.1', port: socket.address().port, sync: true });
  try {
    output.sendUniverse(0, Buffer.alloc(512));
    output.sendUniverse(1, Buffer.alloc(512));
    output.endFrame();
    state.artnet.sync = false;
    output.sendUniverse(0, Buffer.alloc(512));
    output.endFrame();
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(ops, [0x5000, 0x5000, 0x5200, 0x5000], 'two universes, one sync; then no sync once it is off');
  } finally {
    Object.assign(state.artnet, before);
    socket.close();
  }
});
