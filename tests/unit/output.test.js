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
// A Hue lamp is a fixture of its own with no DMX address, patched as the
// channels of the entertainment area it renders, one a section. It is rendered
// like any other fixture, and each channel takes its section's colour from the
// rendered universe rather than from the engine's intermediate values. That is what makes a Hue lamp obey the
// dimmer, the trim, the master and blackout for free — so these tests read
// the buffer the same way the real path does.

import * as universes from '../../src/server/universes.ts';
import { state, universeOf, placeAddresslessFixtures } from '../../src/server/state.ts';
import { BUILTIN_PROFILE_ID, getProfile, registerProfile, unregisterProfile } from '../../src/server/profiles.ts';
import { hueProfile } from '../../src/server/hue-profile.ts';
import { areaLamp, HUE_COLOR, HUE_AMBIANCE, HUE_WHITE, HUE_GRADIENT } from './hue-test-lamps.js';
import dgram from 'node:dgram';

/**
 * Run `fn` on a patch of these lamps — `{ channel, profile }` or
 * `{ channels, profile }` (a colour bulb by default), or `{ par }` for a DMX
 * par among them — each rendered into a clean frame. `fn` gets
 * `set(index, attribute, value, section)`, which writes one channel of a
 * fixture (of one section of it) the way the engine would.
 */
function withLamps(lamps, fn) {
  const saved = { fixtures: state.fixtures, next: state.nextFixtureId };
  const profiles = [...new Set(lamps.filter((l) => !l.par).map((l) => l.profile ?? HUE_COLOR))];
  for (const profile of profiles) registerProfile(profile);
  state.fixtures = lamps.map((lamp, i) => (lamp.par
    ? { id: 100 + i, label: `Par ${i}`, address: 1, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null }
    : {
      id: 100 + i, label: `Lamp ${i}`, address: 1, universe: 0, profileId: (lamp.profile ?? HUE_COLOR).id,
      maxBrightness: 255, override: null, output: { protocol: 'hue', bridge: lamp.bridge ?? 'b1', channels: lamp.channels ?? [lamp.channel] },
    }));
  placeAddresslessFixtures();
  const clean = () => { for (const fix of state.fixtures) universes.getBuffer(universeOf(fix)).fill(0); };
  const set = (index, attribute, value, section) => {
    const fix = state.fixtures[index];
    const profile = getProfile(fix);
    const map = section === undefined ? profile.channelMap : profile.cells[section].channelMap;
    universes.getBuffer(universeOf(fix))[fix.address - 1 + map[attribute]] = value;
  };
  clean();
  try {
    return fn(set);
  } finally {
    clean();
    state.fixtures = saved.fixtures;
    state.nextFixtureId = saved.next;
    for (const profile of profiles) unregisterProfile(profile.id);
  }
}

/** The frame for bridge b1, which is where every lamp here is unless it says otherwise. */
const colors = (bridge = 'b1') => output.hueChannelColors().get(bridge) ?? [];

// Two bridges stream two areas: each is sent the colours of its own lamps,
// and the same channel number on each is two different lamps.
test('each bridge is collected its own frame, and only bridges with a lamp in the patch get one', () => {
  withLamps([{ channel: 0 }, { channel: 0, bridge: 'b2' }, { channel: 4, bridge: 'b2' }], (set) => {
    set(0, 'red', 10); set(1, 'red', 20); set(2, 'green', 30);
    const frames = output.hueChannelColors();
    assert.deepStrictEqual([...frames.keys()], ['b1', 'b2']);
    assert.deepStrictEqual(frames.get('b1'), [{ id: 0, r: 10, g: 0, b: 0 }]);
    assert.deepStrictEqual(frames.get('b2'), [{ id: 0, r: 20, g: 0, b: 0 }, { id: 4, r: 0, g: 30, b: 0 }]);
  });
});

test('a lamp\'s channel takes the colour it was rendered', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'red', 180); set(0, 'green', 90); set(0, 'blue', 20);
    assert.deepStrictEqual(colors(), [{ id: 0, r: 180, g: 90, b: 20 }]);
  });
});

test('each section of a gradient lamp is sent on its own channel, in order along it', () => {
  withLamps([{ channels: [3, 4, 5, 6, 7], profile: HUE_GRADIENT }], (set) => {
    set(0, 'red', 200, 0);
    set(0, 'green', 150, 2);
    set(0, 'blue', 100, 4);
    assert.deepStrictEqual(colors(), [
      { id: 3, r: 200, g: 0, b: 0 },
      { id: 4, r: 0, g: 0, b: 0 },
      { id: 5, r: 0, g: 150, b: 0 },
      { id: 6, r: 0, g: 0, b: 0 },
      { id: 7, r: 0, g: 0, b: 100 },
    ]);
  });
});

test('each lamp is sent on its own channel, in patch order', () => {
  withLamps([{ channel: 5 }, { channel: 2 }], (set) => {
    set(0, 'red', 20);
    set(1, 'red', 10);
    assert.deepStrictEqual(colors().map((c) => [c.id, c.r]), [[5, 20], [2, 10]]);
  });
});

// Only a Hue lamp reaches the bridge: a par has no Hue channel, and no Hue
// channel can be pointed at one.
test('a par in the patch is never sent to the bridge', () => {
  withLamps([{ par: true }, { channel: 3 }], (set) => {
    set(0, 'red', 255);
    assert.deepStrictEqual(colors(), [{ id: 3, r: 0, g: 0, b: 0 }]);
  });
});

test('two lamps on one channel: the first in the patch is shown', () => {
  withLamps([{ channel: 1 }, { channel: 1 }], (set) => {
    set(0, 'blue', 40); set(1, 'blue', 200);
    assert.deepStrictEqual(colors(), [{ id: 1, r: 0, g: 0, b: 40 }]);
  });
});

test('no lamp in the patch means no Hue message at all', () => {
  withLamps([{ par: true }], () => {
    assert.deepStrictEqual(colors(), []);
  });
});

// Hue cannot emit UV. Dropping it would leave the lamps black through an entire
// UV wash while the pars glowed, which reads as a dead lamp.
test('a UV wash shows as deep violet rather than black', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'uv', 200);
    const [color] = colors();
    assert.ok(color.b > color.r && color.r > 0, 'violet: blue-dominant but not pure blue');
    assert.strictEqual(color.g, 0);
  });
});

// The colour dies and the whites together can sum past what the lamp can
// show. Clamping each primary on its own would move the hue; scaling all three
// together keeps the colour and gives up brightness instead.
test('an over-full mix is scaled as a whole, keeping its hue', () => {
  const tungsten = hueProfile(areaLamp({ id: 'tungsten', whites: { warm: 2700, cool: 6500 } }));
  withLamps([{ channel: 0, profile: tungsten }], (set) => {
    set(0, 'red', 255); set(0, 'warmWhite', 255);
    assert.deepStrictEqual(colors(), [{ id: 0, r: 255, g: 83, b: 44 }], 'still a warm red');
  });
});

test('a mix that fits is left exactly as it is', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'red', 100); set(0, 'green', 50); set(0, 'blue', 25);
    assert.deepStrictEqual(colors(), [{ id: 0, r: 100, g: 50, b: 25 }]);
  });
});

// Blackout and the grand master are already applied by the time the frame is
// written, so an all-zero buffer is the whole story.
test('a blacked-out rig sends black to Hue', () => {
  withLamps([{ channel: 0 }], () => {
    assert.deepStrictEqual(colors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
  });
});

// The one that would be easy to get wrong: a white bulb has no colour channels
// at all, so without the fallback it would read as black and the lamp would
// never light.
test('a white lamp lights at its dimmer level, at the white the bridge says it is', () => {
  withLamps([{ channel: 0, profile: HUE_WHITE }], (set) => {
    set(0, 'dimmer', 140);
    const [color] = colors();
    assert.strictEqual(color.r, 140);
    assert.ok(color.b < color.g && color.g < color.r, `a 2700 K white (got ${JSON.stringify(color)})`);
  });
});

test('a white lamp that does not say which white is shown neutral', () => {
  const unsaid = hueProfile(areaLamp({ id: 'unsaid', gamut: null, whites: null }));
  withLamps([{ channel: 0, profile: unsaid }], (set) => {
    set(0, 'dimmer', 140);
    assert.deepStrictEqual(colors(), [{ id: 0, r: 140, g: 140, b: 140 }]);
  });
});

test('a white lamp at zero is black rather than stuck on', () => {
  withLamps([{ channel: 0, profile: HUE_WHITE }], () => {
    assert.deepStrictEqual(colors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
  });
});

// ── The two white dies ──────────────────────────────────────────────────────
// A Hue lamp that tunes white has a warm and a cool die. The Entertainment
// stream has no white channel, so they fold into the RGB that goes out — at
// the temperatures the bridge says the lamp's whites are, which is what keeps
// a warm wash warm.

test('the warm white die folds in warm, not neutral and not orange', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'warmWhite', 255);
    const [color] = colors();
    assert.strictEqual(color.r, 255);
    assert.ok(color.g < color.r, 'warmer than neutral white');
    assert.ok(color.b > 0, 'but still a white — a tungsten white has blue in it');
    assert.ok(color.b < color.g, 'and warm rather than pink');
  });
});

test('the cool white die folds in near neutral', () => {
  withLamps([{ channel: 0 }], (set) => {
    set(0, 'coolWhite', 200);
    const [color] = colors();
    for (const v of [color.r, color.g, color.b]) {
      assert.ok(Math.abs(v - 200) <= 6, `close to neutral at the same level (got ${v})`);
    }
  });
});

test('the whites fold at the lamp\'s own temperatures', () => {
  const read = (whites) => withLamps([{ channel: 0, profile: hueProfile(areaLamp({ id: `w${whites.warm}`, whites })) }], (set) => {
    set(0, 'warmWhite', 255);
    return colors()[0];
  });
  const candle = read({ warm: 2000, cool: 6500 });
  const tungsten = read({ warm: 2700, cool: 6500 });
  assert.ok(candle.b < tungsten.b && candle.g < tungsten.g, 'a lamp that goes down to 2000 K shows a warmer warm white');
});

test('warm reads warmer than cool at the same level', () => {
  const read = (attribute) => withLamps([{ channel: 0 }], (set) => {
    set(0, attribute, 255);
    return colors()[0];
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
  withLamps([{ channel: 0, profile: HUE_AMBIANCE }], (set) => {
    set(0, 'dimmer', 255);
    set(0, 'coolWhite', 100);
    const [color] = colors();
    assert.ok(Math.abs(color.r - 100) <= 4, `the white die alone decides it (got ${color.r})`);
  });
});

// Until a hostname resolves, Art-Net frames are dropped. sendUniverse used to
// report them as sent regardless.
// ── On the wire ─────────────────────────────────────────────────────────────
// What follows puts frames on the wire through the live config, which carries
// whether the outputs are armed (armed.ts) — off, as the server starts, and
// every frame below would be dropped. Armed for these, and put back after.

test.before(() => output.setArmed(true));
test.after(() => output.setArmed(false));

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
    output.configureHue({ bridges: hueBefore.bridges, latencyMs: hueBefore.latencyMs });
    socket.close();
  }
}

// A bridge that is on and fully set up; nothing here sends it a frame, so it is never contacted.
const ON = {
  id: 'b1', label: 'Lounge', enabled: true, host: '10.0.0.9', username: 'key', clientKey: 'aabb', applicationId: '',
  entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
};
const frameMarked = (marker) => { const f = Buffer.alloc(512); f[0] = marker; return f; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('with Hue on, Art-Net frames go out the configured delay after they were rendered', async () => {
  let start = 0;
  const got = await artnetCapture(async () => {
    output.configureHue({ bridges: [ON], latencyMs: 80 });
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
  for (const config of [{ bridges: [], latencyMs: 80 }, { bridges: [{ ...ON, enabled: false }], latencyMs: 80 }, { bridges: [ON], latencyMs: 0 }]) {
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
    output.configureHue({ bridges: [ON], latencyMs: 200 });
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
