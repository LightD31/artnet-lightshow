// Protocol v2: the live page is sent the keys that changed, grouped by domain
// and versioned, and DMX as bytes, only while it asks for it. Whatever
// connects without asking — the Companion module, an older page — still
// gets the whole state as before.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

import { StateDiffer, createPublisher, domainOf, ROOM } from '../../src/server/protocol.ts';
import { encodeDmxFrame, decodeDmxFrame } from '../../src/shared/dmx-frame.ts';
import { attachSockets } from '../../src/server/sockets.ts';
import { state, getLiveState, getDmxUniverses } from '../../src/server/state.ts';
import { applyPatch } from '../../src/server/patch.ts';

test('only the keys that changed go out, grouped by domain, each domain counting its own versions', () => {
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
  assert.deepStrictEqual(differ.versions(), { look: 2, rig: 2, show: 0, sources: 2, catalogs: 0, system: 1 });
  assert.strictEqual(domainOf('autoShow'), 'show');
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

test('a page that asks for protocol 2 gets a snapshot, then only what changed; the others the whole state', async () => {
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
