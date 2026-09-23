import test from 'node:test';
import assert from 'node:assert';

import * as output from '../../src/server/output.js';

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

// ── Hue channel mapping ─────────────────────────────────────────────────────
// A Hue channel follows a fixture, and takes its colour from the rendered DMX
// frame rather than from the engine's intermediate values. That is what makes a
// Hue lamp obey the dimmer, the trim, the master and blackout for free — so
// these tests read the buffer the same way the real path does.

import * as universes from '../../src/server/universes.js';
import { state, universeOf } from '../../src/server/state.js';

// Builtin profile offsets, from the fixture at address 1 (base 0).
const RED = 3, GREEN = 4, BLUE = 5, WHITE = 6, AMBER = 7, UV = 8;

/**
 * Run `fn` with the given bindings in place and a clean frame to write into.
 *
 * The universe comes from the fixture rather than being hardcoded: the rig's
 * default universe is an operator setting, so a test that assumed 0 passed or
 * failed depending on whose settings.json was on the machine.
 */
function withHueChannels(channels, fn) {
  const before = output.getHueConfig();
  const universe = universeOf(state.fixtures[0]);
  universes.getBuffer(universe).fill(0);
  try {
    output.configureHue({ channels });
    return fn(universes.getBuffer(universe));
  } finally {
    output.configureHue({ channels: before.channels });
    universes.getBuffer(universe).fill(0);
  }
}

test('a bound channel takes the colour of its fixture', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[RED] = 200; dmx[GREEN] = 100; dmx[BLUE] = 50;
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 200, g: 100, b: 50 }]);
  });
});

// A fixture that has been deleted from the patch leaves its binding pointing at
// nothing. Sending a black frame would look like a broken lamp; sending nothing
// leaves the bridge holding its own colour, which is the honest answer.
test('a channel bound to a fixture that no longer exists is skipped', () => {
  withHueChannels([{ channel: 0, fixture: 9999 }], () => {
    assert.deepStrictEqual(output.hueChannelColors(), []);
  });
});

test('channels come back in the order they are bound', () => {
  withHueChannels([
    { channel: 5, fixture: state.fixtures[1].id },
    { channel: 2, fixture: state.fixtures[0].id },
  ], (dmx) => {
    dmx[RED] = 10;                                  // fixture 0, address 1
    dmx[12 + RED] = 20;                             // fixture 1, address 13
    const colors = output.hueChannelColors();
    assert.deepStrictEqual(colors.map((c) => c.id), [5, 2]);
    assert.strictEqual(colors[0].r, 20);
    assert.strictEqual(colors[1].r, 10);
  });
});

// Hue lamps have no white emitter of their own, so a look built on the par's
// white channel would come out black on Hue if white were ignored.
test('the white emitter lifts all three primaries equally', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[WHITE] = 80;
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 80, g: 80, b: 80 }]);
  });
});

// Amber is not white. Folding it in as if it were would turn a warm wash cold
// on the Hue lamps while the pars stayed amber.
test('amber folds in warm rather than neutral', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[AMBER] = 100;
    const [color] = output.hueChannelColors();
    assert.strictEqual(color.r, 100);
    assert.strictEqual(color.g, 75);
    assert.strictEqual(color.b, 0, 'amber has no blue in it');
  });
});

// Hue cannot emit UV. Dropping it would leave the lamps black through an entire
// UV wash while the pars glowed, which reads as a dead lamp.
test('a UV wash shows as deep violet rather than black', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[UV] = 200;
    const [color] = output.hueChannelColors();
    assert.ok(color.b > color.r && color.r > 0, 'violet: blue-dominant but not pure blue');
    assert.strictEqual(color.g, 0);
  });
});

// A par mixes light physically, so its emitters together are brighter than a
// Hue lamp can go. Clamping each primary on its own would move the hue: amber
// sums past full on red and green but not blue, so it would clamp to yellow.
// Scaling all three together keeps the colour and gives up brightness instead.
test('an over-full mix is scaled as a whole, keeping its hue', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[RED] = 255; dmx[WHITE] = 255; dmx[AMBER] = 255;
    const [color] = output.hueChannelColors();
    assert.strictEqual(color.r, 255, 'the strongest primary reaches full');
    assert.ok(color.g < 255, 'and the others stay below it rather than clamping up');
    assert.ok(color.b < color.g, 'so the mix is still warm');
  });
});

// Independent clamping produced (255, 255, 87) here, which is yellow. The
// ratios of the real mix are what make it read as amber.
test('a mix that overflows keeps its ratios rather than turning yellow', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[RED] = 200; dmx[GREEN] = 150; dmx[AMBER] = 255;
    const [color] = output.hueChannelColors();
    assert.strictEqual(color.r, 255);
    assert.ok(color.g > 150 && color.g < 210, `amber, not yellow (got g=${color.g})`);
    assert.ok(color.b < color.g / 2);
  });
});

test('a mix that fits is left exactly as it is', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], (dmx) => {
    dmx[RED] = 100; dmx[GREEN] = 50; dmx[BLUE] = 25;
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 100, g: 50, b: 25 }]);
  });
});

// Blackout and the grand master are already applied by the time the frame is
// written, so an all-zero buffer is the whole story.
test('a blacked-out rig sends black to Hue', () => {
  withHueChannels([{ channel: 0, fixture: state.fixtures[0].id }], () => {
    assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
  });
});

test('no bindings means no Hue message at all', () => {
  withHueChannels([], () => {
    assert.deepStrictEqual(output.hueChannelColors(), []);
  });
});

// Guards the settings round-trip: a malformed entry must not reach the render
// loop, where it would be read 40 times a second.
test('malformed bindings are dropped at configure time', () => {
  const before = output.getHueConfig();
  try {
    output.configureHue({ channels: [
      { channel: 0, fixture: 0 },
      { channel: 'one', fixture: 1 },
      { channel: 2 },
      null,
    ] });
    assert.deepStrictEqual(output.getHueConfig().channels, [{ channel: 0, fixture: 0 }]);
  } finally {
    output.configureHue({ channels: before.channels });
  }
});

// ── Hue lamp profiles end to end ────────────────────────────────────────────
// A Hue-only lamp is patched as a fixture on one of the built-in Hue profiles.
// These check that such a fixture reaches the bridge correctly, since the whole
// point of the profiles is that no special case is needed anywhere.

import { HUE_COLOR_PROFILE_ID, HUE_WHITE_PROFILE_ID, getProfile } from '../../src/server/profiles.js';

/** Temporarily move a fixture onto another profile. */
function onProfile(fixture, profileId, fn) {
  const before = fixture.profileId;
  fixture.profileId = profileId;
  try {
    return fn(getProfile(fixture).channelMap);
  } finally {
    fixture.profileId = before;
  }
}

test('a lamp on the colour profile sends its RGB straight through', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => {
    onProfile(fixture, HUE_COLOR_PROFILE_ID, (ch) => {
      const base = fixture.address - 1;
      dmx[base + ch.red] = 180;
      dmx[base + ch.green] = 90;
      dmx[base + ch.blue] = 20;
      assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 180, g: 90, b: 20 }]);
    });
  });
});

// The one that would be easy to get wrong: a white bulb has no colour channels
// at all, so without the fallback it would read as black and the lamp would
// never light.
test('a lamp on the white profile lights at its dimmer level, in neutral white', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => {
    onProfile(fixture, HUE_WHITE_PROFILE_ID, (ch) => {
      dmx[fixture.address - 1 + ch.dimmer] = 140;
      assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 140, g: 140, b: 140 }]);
    });
  });
});

test('a white-profile lamp at zero is black rather than stuck on', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], () => {
    onProfile(fixture, HUE_WHITE_PROFILE_ID, () => {
      assert.deepStrictEqual(output.hueChannelColors(), [{ id: 0, r: 0, g: 0, b: 0 }]);
    });
  });
});

// Mixed rigs are the normal case: a few pars and a few Hue lamps, each read
// through its own profile's channel map.
test('pars and Hue lamps are read through their own profiles in one frame', () => {
  const par = state.fixtures[0];
  const lamp = state.fixtures[1];
  withHueChannels([
    { channel: 0, fixture: par.id },
    { channel: 1, fixture: lamp.id },
  ], (dmx) => {
    onProfile(lamp, HUE_COLOR_PROFILE_ID, (lampCh) => {
      dmx[par.address - 1 + getProfile(par).channelMap.red] = 200;
      dmx[lamp.address - 1 + lampCh.blue] = 90;
      const colors = output.hueChannelColors();
      assert.strictEqual(colors[0].r, 200, 'the par, on its 12-channel map');
      assert.strictEqual(colors[1].b, 90, 'the lamp, on its 4-channel map');
      assert.strictEqual(colors[1].r, 0);
    });
  });
});

// ── The two white dies ──────────────────────────────────────────────────────
// A Hue colour bulb is RGBWW. The Entertainment stream has no white channel, so
// the warm and cool dies fold into the RGB that goes out — at their real colour
// temperature, which is what keeps a warm wash warm.

import { HUE_WHITE_AMBIANCE_PROFILE_ID } from '../../src/server/profiles.js';
import dgram from 'node:dgram';

test('the warm white die folds in warm, not neutral and not orange', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => {
    onProfile(fixture, HUE_COLOR_PROFILE_ID, (ch) => {
      dmx[fixture.address - 1 + ch.warmWhite] = 255;
      const [color] = output.hueChannelColors();
      assert.strictEqual(color.r, 255);
      assert.ok(color.g < color.r, 'warmer than neutral white');
      assert.ok(color.b > 0, 'but still a white — a tungsten white has blue in it');
      assert.ok(color.b < color.g, 'and warm rather than pink');
    });
  });
});

test('the cool white die folds in near neutral', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => {
    onProfile(fixture, HUE_COLOR_PROFILE_ID, (ch) => {
      dmx[fixture.address - 1 + ch.coolWhite] = 200;
      const [color] = output.hueChannelColors();
      for (const v of [color.r, color.g, color.b]) {
        assert.ok(Math.abs(v - 200) <= 6, `close to neutral at the same level (got ${v})`);
      }
    });
  });
});

test('warm reads warmer than cool at the same level', () => {
  const fixture = state.fixtures[0];
  const read = (channel) => withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => (
    onProfile(fixture, HUE_COLOR_PROFILE_ID, (ch) => {
      dmx[fixture.address - 1 + ch[channel]] = 255;
      return output.hueChannelColors()[0];
    })
  ));
  const warm = read('warmWhite');
  const cool = read('coolWhite');
  assert.ok(warm.b < cool.b, 'less blue is what makes a white read as warm');
  assert.ok(warm.g < cool.g);
});

// A tunable-white lamp has the two white dies but no primaries. The neutral
// fallback keys off having no emitters at all, not off having no primaries —
// otherwise it would add the dimmer on top of the whites and double up.
test('a white ambiance lamp is not also given its dimmer as white', () => {
  const fixture = state.fixtures[0];
  withHueChannels([{ channel: 0, fixture: fixture.id }], (dmx) => {
    onProfile(fixture, HUE_WHITE_AMBIANCE_PROFILE_ID, (ch) => {
      const base = fixture.address - 1;
      dmx[base + ch.dimmer] = 255;
      dmx[base + ch.coolWhite] = 100;
      const [color] = output.hueChannelColors();
      assert.ok(Math.abs(color.r - 100) <= 4, `the white die alone decides it (got ${color.r})`);
    });
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
