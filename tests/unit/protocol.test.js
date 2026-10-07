// Protocol v2: the live page is sent the keys that changed, grouped by domain
// and versioned, and DMX as bytes, only while it asks for it. Whatever
// connects without asking — the Companion module, an older page — still
// gets the whole state as before.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { StateDiffer, createPublisher, domainOf, hasDomain, clockMoved, ROOM } from '../../src/server/protocol.ts';
import { encodeDmxFrame, decodeDmxFrame } from '../../src/shared/dmx-frame.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, getDmxUniverses } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { conductor } from '../../src/server/conductor.ts';

test('deltas version changed keys independently by domain', () => {
  const differ = new StateDiffer();
  const first = differ.diff({ masterDimmer: 255, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 });
  assert.deepStrictEqual(first.map((p) => [p.d, p.v, Object.keys(p.set)]), [
    ['look', 1, ['masterDimmer', 'pattern']],
    ['rig', 1, ['fixtures']],
    ['sources', 1, ['spotify']],
    ['system', 1, ['mystery']],
  ]);

  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 }),
    [{ d: 'look', v: 2, set: { masterDimmer: 128 } }], 'a fader moved: that key, nothing else');
  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0 }], spotify: { ok: true }, mystery: 1 }), [],
    'nothing changed, nothing sent');
  assert.deepStrictEqual(differ.diff({ masterDimmer: 128, pattern: 'chase', fixtures: [{ id: 0, label: 'Left' }], mystery: 1 }), [
    { d: 'rig', v: 2, set: { fixtures: [{ id: 0, label: 'Left' }] } },
    { d: 'sources', v: 2, set: {}, del: ['spotify'] },
  ], 'an edited fixture and a key that went away');
  assert.deepStrictEqual(differ.versions(), { look: 2, rig: 2, show: 0, sources: 2, audio: 0, sequence: 0, catalogs: 0, library: 0, voices: 0, pads: 0, system: 1 });
  assert.strictEqual(domainOf('autoShow'), 'show');
  assert.strictEqual(domainOf('hueBridges'), 'rig', 'the patch table reads the bridges with the fixtures');
  assert.strictEqual(domainOf('toString'), 'system', 'only the keys it names');
});

test('a DMX frame is each universe\'s channels as bytes, and reads back the same', () => {
  const a = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const b = Uint8Array.from([255, 0, 128]);
  const frame = encodeDmxFrame([[0, a], [37, b]]);
  assert.strictEqual(frame.length, 2 + 4 + 512 + 4 + 3);
  const back = decodeDmxFrame(frame);
  assert.deepStrictEqual(Object.keys(back), ['0', '37']);
  assert.deepStrictEqual([...back[0]], [...a]);
  assert.deepStrictEqual([...back[37]], [...b]);
  assert.deepStrictEqual(decodeDmxFrame(frame.buffer).constructor, Object, 'from an ArrayBuffer too');
  assert.strictEqual(decodeDmxFrame(frame.subarray(0, 100)), null, 'a frame that runs short');
  assert.strictEqual(decodeDmxFrame(Uint8Array.from([9, 0])), null, 'a format it does not know');
  assert.deepStrictEqual(decodeDmxFrame(encodeDmxFrame([])), {}, 'no universes');
});

// The clock's beat moves on every read. A screen carries the last one it was
// sent on at its tempo, so only a beat that carrying-on would miss is news.
test('a clock is news when a screen carrying the last one on would miss it', () => {
  const sent = { source: 'tap', bpm: 120, beatPos: 10, epoch: 3, at: 1_000_000 };
  const later = (ms, beatPos, over = {}) => ({ ...sent, at: sent.at + ms, beatPos, ...over });
  assert.strictEqual(clockMoved(sent, later(30000, 70)), false, 'half a minute on, where its tempo put it');
  assert.strictEqual(clockMoved(sent, later(30000, 70.03)), false, 'within a frame of a 60 Hz screen');
  assert.strictEqual(clockMoved(sent, later(30000, 70.04)), true, 'more than a frame out');
  assert.strictEqual(clockMoved(sent, later(30000, 69.96)), true, 'behind as well as ahead');
  assert.strictEqual(clockMoved(sent, later(500, 12)), true, 'a tap that put the beat ahead');
  assert.strictEqual(clockMoved(sent, later(5000, 10)), false, 'a stopped clock stands where it was sent');
  assert.strictEqual(clockMoved(sent, later(0, 10, { bpm: 128 })), true, 'a new tempo');
  assert.strictEqual(clockMoved(sent, later(0, 10, { epoch: 4 })), true, 'a new epoch');
  assert.strictEqual(clockMoved(sent, later(0, 10, { source: 'live' })), true, 'a new source');
  assert.strictEqual(clockMoved(undefined, sent), true, 'nothing sent yet');
  assert.strictEqual(clockMoved({ source: 'tap', bpm: 120 }, { source: 'tap', bpm: 120 }), false, 'no beat to carry: compared as it is');

  const differ = new StateDiffer();
  assert.deepStrictEqual(differ.diff({ clock: sent, bpm: 120 }).map((p) => Object.keys(p.set)), [['clock', 'bpm']]);
  assert.deepStrictEqual(differ.diff({ clock: later(1000, 12), bpm: 120 }), [], 'carried on as expected');
  assert.deepStrictEqual(differ.diff({ clock: later(1000, 12), bpm: 121 }).map((p) => p.set), [{ bpm: 121 }], 'only the key that changed');
  assert.deepStrictEqual(differ.diff({ clock: later(2000, 15), bpm: 121 }).map((p) => p.set), [{ clock: later(2000, 15) }]);
});

// ── Over a real socket ───────────────────────────────────────────────────────

async function serve() {
  const server = http.createServer();
  const io = new Server(server);
  const publisher = createPublisher(io);
  const integrations = { broadcast: () => publisher.publishState(getLiveState()), publisher };
  attachSockets(io, { midi: { onLearn() {}, enabled: false, listPorts: () => [] }, integrations });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  return {
    io, publisher, integrations,
    client(auth = {}) {
      const socket = connect(url, { transports: ['websocket'], auth, forceNew: true });
      clients.push(socket);
      return socket;
    },
    async close() {
      for (const c of clients) c.close();
      io.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

test('protocol 2 subscribers receive snapshots followed by deltas', async () => {
  const s = await serve();
  try {
    const v2 = s.client({ protocol: 2 });
    const v1 = s.client();
    const [snapshot, full] = await Promise.all([next(v2, 'snapshot'), next(v1, 'state')]);
    assert.strictEqual(snapshot.protocol, 2);
    assert.ok(Array.isArray(snapshot.state.fixtures) && Array.isArray(snapshot.state.colorPresets), 'the whole state, catalogues included');
    assert.strictEqual(snapshot.state.dmxSnapshot, undefined, 'DMX has its own feed');
    assert.ok(full.dmxSnapshot, 'protocol 1 as it always was');
    s.integrations.broadcast();
    await new Promise((r) => setTimeout(r, 50));

    const patch = next(v2, 'patch');
    const whole = next(v1, 'state');
    applyPatch({ masterDimmer: 77 });
    s.integrations.broadcast();
    const [p, w] = await Promise.all([patch, whole]);
    assert.strictEqual(p.d, 'look');
    assert.deepStrictEqual(p.set, { masterDimmer: 77 });
    assert.ok(p.v > snapshot.versions.look);
    assert.strictEqual(w.masterDimmer, 77);
    assert.ok(Array.isArray(w.fixtures), 'protocol 1: everything, every time');

    const resync = await v2.emitWithAck('sync');
    assert.strictEqual(resync.state.masterDimmer, 77);
    assert.strictEqual(resync.versions.look, p.v);
  } finally {
    applyPatch({ masterDimmer: 255 });
    await s.close();
  }
});

test('DMX goes out as bytes only to the pages that subscribed to it', async () => {
  const s = await serve();
  try {
    const watching = s.client({ protocol: 2 });
    const other = s.client({ protocol: 2 });
    await Promise.all([next(watching, 'snapshot'), next(other, 'snapshot')]);
    let otherFrames = 0;
    other.on('dmx-frame', () => otherFrames++);
    assert.strictEqual(s.publisher.wants(ROOM.dmx), false, 'nobody subscribed: no feed built');

    watching.emit('subscribe', ['dmx', 'nonsense']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(s.publisher.wants(ROOM.dmx), true);
    const arrived = next(watching, 'dmx-frame');
    assert.ok(s.publisher.sendDmxFrame(Uint8Array.from([1, 1, 0, 0, 3, 0, 10, 20, 30])));
    const frame = decodeDmxFrame(await arrived);
    assert.deepStrictEqual([...frame[0]], [10, 20, 30]);
    assert.strictEqual(s.publisher.sendDmxFrame(Uint8Array.from([1, 1, 0, 0, 3, 0, 10, 20, 30])), false, 'the same frame is not sent twice');

    // A page subscribing late gets the frame the others already have.
    const late = next(other, 'dmx-frame');
    other.emit('subscribe', 'dmx');
    assert.deepStrictEqual([...decodeDmxFrame(await late)[0]], [10, 20, 30]);

    watching.emit('unsubscribe', ['dmx']);
    other.emit('unsubscribe', ['dmx']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(s.publisher.wants(ROOM.dmx), false);
    assert.strictEqual(otherFrames, 1, 'only the frame it subscribed for');
  } finally {
    await s.close();
  }
});

test('the frame the feed sends is the engine\'s universes as they are patched', () => {
  const frame = decodeDmxFrame(encodeDmxFrame(getDmxUniverses()));
  const universes = Object.keys(frame).map(Number);
  assert.ok(universes.length >= 1);
  const last = Math.max(...state.fixtures.filter((f) => (f.universe ?? 0) === universes[0]).map((f) => f.address));
  assert.ok(frame[universes[0]].length >= last, 'up to the last patched channel at least');
});

// The library a client edits mid-show is a domain of its own; the built-ins
// beside it are catalogues, sent once; the colours over the effects and the
// gate on the fast ones are the look's.
test('the library domain: saved presets and palettes; the built-ins stay catalogues', () => {
  assert.strictEqual(domainOf('effects'), 'library');
  assert.strictEqual(domainOf('userPalettes'), 'library');
  for (const key of ['palettes', 'families', 'builtinPalettes', 'patterns']) assert.strictEqual(domainOf(key), 'catalogs', key);
  assert.strictEqual(domainOf('paletteOverride'), 'look');
  assert.strictEqual(domainOf('paletteOverrideId'), 'look');
  assert.strictEqual(domainOf('safety'), 'look');
});

// A key no domain names goes out as `system`, which no view watches.
test('every key of the live state names its domain, the tempo mode the look\'s', () => {
  assert.strictEqual(domainOf('tempoMode'), 'look');
  const unnamed = Object.keys(getLiveState()).filter((key) => domainOf(key) === 'system');
  assert.deepStrictEqual(unnamed, []);
});

// The live state is published when something in it changed, by every
// broadcast and the once-a-second sweep. A clock read afresh each time must
// not make every one of them a change, to either protocol.
test('a beat that moves as it should adds nothing to the broadcasts', async () => {
  const s = await serve();
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // What is sent arrives in order on each socket, but a busy runner may take a
  // while: wait for it by deadline, and pause only to show nothing more came.
  const until = async (done, what) => {
    const end = Date.now() + 10000;
    while (!done()) {
      assert.ok(Date.now() < end, `still waiting for ${what}`);
      await pause(5);
    }
  };
  try {
    const v2 = s.client({ protocol: 2 });
    const v1 = s.client();
    await Promise.all([next(v2, 'snapshot'), next(v1, 'state')]);
    const patches = [];
    const states = [];
    v2.on('patch', (p) => patches.push(p));
    v1.on('state', (w) => states.push(w));
    // Once both have this fader, everything sent before it has arrived too.
    applyPatch({ masterDimmer: 76 });
    s.integrations.broadcast();
    await until(() => patches.some((p) => p.set.masterDimmer === 76) && states.some((w) => w.masterDimmer === 76), 'the first broadcast');
    patches.length = 0;
    states.length = 0;

    for (let i = 0; i < 20; i++) { s.integrations.broadcast(); await pause(10); }
    await pause(50);
    assert.deepStrictEqual([patches.length, states.length], [0, 0], 'twenty sweeps of a running clock: nothing to send');

    const sentAfter = Date.now();
    applyPatch({ masterDimmer: 77 });
    s.integrations.broadcast();
    await until(() => patches.length && states.length, 'the fader');
    await pause(50);
    assert.deepStrictEqual(patches.map((p) => p.set), [{ masterDimmer: 77 }], 'the fader, without the clock');
    assert.strictEqual(states.length, 1);
    assert.ok(states[0].clock.at >= sentAfter, 'protocol 1 gets the whole state, the clock read with it');

    // The clock stopping is news once, and standing still is not.
    conductor.setRunning(false);
    for (let i = 0; i < 10; i++) { s.integrations.broadcast(); await pause(10); }
    await until(() => patches.length >= 2, 'the stop');
    await pause(50);
    assert.deepStrictEqual(patches.slice(1).map((p) => Object.keys(p.set)), [['clock']]);
    const stopped = patches[1].set.clock;
    conductor.setRunning(true);
    await pause(30);
    s.integrations.broadcast();
    await until(() => patches.length >= 3 && states.length >= 3, 'moving again');
    await pause(50);
    assert.strictEqual(patches.length, 3, 'moving again is news');
    assert.ok(patches[2].set.clock.beatPos >= stopped.beatPos && patches[2].set.clock.epoch === stopped.epoch);
    assert.strictEqual(states.length, 3, 'protocol 1 is sent exactly when protocol 2 is');
  } finally {
    conductor.setRunning(true);
    applyPatch({ masterDimmer: 255 });
    await s.close();
  }
});

test('every live-state key is in DOMAIN_OF', () => {
  const missing = Object.keys(getLiveState()).filter((key) => !hasDomain(key));
  assert.deepStrictEqual(missing, []);
  // The integrations' keys and the deck's, which need a running server to appear.
  const named = ['strobe', 'pads', 'sequence', 'sequences', 'sequencePatterns', 'voices', 'matrix', 'audio', 'paletteOverride', 'safety', 'effects', 'userPalettes',
    'spotify', 'nowPlaying', 'prolink', 'live', 'cues', 'warm', 'midi', 'autoShow', 'activeSource', 'showOn'];
  assert.deepStrictEqual(named.filter((key) => !hasDomain(key)), []);
  assert.equal(domainOf('matrix'), 'look');
  assert.equal(domainOf('strobe'), 'look');
  assert.equal(domainOf('sequences'), 'sequence');
  assert.equal(domainOf('sequencePatterns'), 'sequence');
});
