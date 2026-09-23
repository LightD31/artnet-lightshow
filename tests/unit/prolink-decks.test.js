// Beat and position packets, and which deck the show follows. Status packets
// only say which beat a deck is in; a beat packet says when it started, and a
// CDJ-3000's position packet says where the playhead is outright. With two
// decks in a mix, the show follows the one the room hears.

import test from 'node:test';
import assert from 'node:assert';
import dgram from 'node:dgram';
import ProLink from '../../src/prolink.ts';
import {
  parseTimingPacket, buildBeatPacket, buildPositionPacket, listenForTiming,
} from '../../src/prolink-packets.ts';

const PLAYING = 3;
const PAUSED = 5;

test('beat and position packets read back, and nothing else on the port does', () => {
  const beat = parseTimingPacket(buildBeatPacket({ deviceId: 2, nextBeatMs: 469, pitch: 2.5, trackBpm: 128, beatInBar: 3 }));
  assert.strictEqual(beat.kind, 'beat');
  assert.deepStrictEqual([beat.deviceId, beat.nextBeatMs, beat.trackBpm, beat.beatInBar], [2, 469, 128, 3]);
  assert.ok(Math.abs(beat.pitch - 2.5) < 1e-3);

  const pos = parseTimingPacket(buildPositionPacket({ deviceId: 3, playheadMs: 61234, trackLengthSec: 301, pitch: -3.26, bpm: 123.9 }));
  assert.deepStrictEqual(pos, { kind: 'position', deviceId: 3, trackLengthSec: 301, playheadMs: 61234, pitch: -3.26, bpm: 123.9 });
  assert.strictEqual(parseTimingPacket(buildPositionPacket({ deviceId: 3, playheadMs: 0 })).bpm, null, 'tempo unknown');

  // alphatheta-connect reads a beat packet as a position; the type byte says otherwise.
  const beatBytes = buildBeatPacket({ deviceId: 1, nextBeatMs: 500, trackBpm: 120, beatInBar: 1 });
  assert.strictEqual(beatBytes[0x20], 0x00, 'the byte the library checks is zero on a beat packet too');
  assert.strictEqual(parseTimingPacket(beatBytes).kind, 'beat');

  const other = Buffer.from(beatBytes);
  other[0x0a] = 0x2a;                                    // sync control
  assert.strictEqual(parseTimingPacket(other), null);
  assert.strictEqual(parseTimingPacket(Buffer.from('not a prolink packet at all, no')), null);
  assert.strictEqual(parseTimingPacket(beatBytes.subarray(0, 0x40)), null, 'truncated');
});

test('timing packets arrive on a socket that shares the port', async () => {
  const got = [];
  const listener = await listenForTiming((p) => got.push(p), { port: 0, address: '127.0.0.1' });
  const tx = dgram.createSocket('udp4');
  try {
    await new Promise((resolve) => tx.send(buildPositionPacket({ deviceId: 4, playheadMs: 1000 }), listener.port, '127.0.0.1', resolve));
    await new Promise((resolve) => tx.send(Buffer.from('noise'), listener.port, '127.0.0.1', resolve));
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(got.map((p) => [p.kind, p.deviceId, p.playheadMs]), [['position', 4, 1000]]);
  } finally {
    tx.close();
    listener.close();
  }
});

// ── One deck ──────────────────────────────────────────────────────────────────

function link() {
  const p = new ProLink();
  let now = 1000;
  p._now = () => now;
  p._resolveTrackMetadata = async (deviceId, slot, trackType, trackId) => ({
    trackId, deviceId, slot, trackType, title: `Track ${trackId}`, artist: 'Artist', durationMs: 300000, beatGrid: null,
  });
  return {
    p,
    advance(ms) { now += ms; },
    get now() { return now; },
    status(deviceId, { trackId = 40 + deviceId, bpm = 120, pitch = 0, beat = 1, playState = PLAYING, master = false, onAir = false } = {}) {
      p._onStatus({
        deviceId, trackDeviceId: deviceId, trackSlot: 3, trackType: 1, trackId, trackBPM: bpm, effectivePitch: pitch,
        beat, beatInMeasure: ((beat - 1) % 4) + 1, playState, isMaster: master, isOnAir: onAir,
      });
    },
  };
}

/**
 * Play a deck at 120 BPM for `seconds`, in 1 ms steps: status packets every
 * 200 ms, and optionally a beat packet on every beat or a position packet
 * every 30 ms. The status packets are late by `statusLagMs`, as a busy player's
 * are, so on their own they leave the phase uncertain.
 */
function play(l, { seconds, beats = false, positions = false, statusLagMs = 0, startMs = 0 }) {
  const beatMs = 500;
  let truth = startMs;
  const errors = [];
  for (let t = 0; t <= seconds * 1000; t++) {
    if (t % 200 === 0) l.status(1, { master: true, beat: Math.floor(Math.max(0, truth - statusLagMs) / beatMs) + 1 });
    if (beats && t > 0 && Math.floor(truth / beatMs) !== Math.floor((truth - 1) / beatMs)) {
      l.p._onTiming({ kind: 'beat', deviceId: 1, nextBeatMs: beatMs, nextBarMs: beatMs, pitch: 0, trackBpm: 120, beatInBar: 1 });
    }
    if (positions && t % 30 === 0) {
      l.p._onTiming({ kind: 'position', deviceId: 1, trackLengthSec: 300, playheadMs: Math.round(truth), pitch: 0, bpm: 120 });
    }
    errors.push(l.p.getPositionMs() - truth);
    l.advance(1);
    truth += 1;
  }
  return errors;
}

const worst = (errors) => Math.max(...errors.map(Math.abs));

test('beat packets pin the phase that status packets only bracket', () => {
  const lagged = play(link(), { seconds: 20, statusLagMs: 180 }).slice(4000);
  const pinned = play(link(), { seconds: 20, statusLagMs: 180, beats: true }).slice(4000);
  assert.ok(worst(pinned) <= 2, `with beat packets, worst error ${worst(pinned).toFixed(1)} ms`);
  assert.ok(worst(lagged) > 50, `status packets alone sit ${worst(lagged).toFixed(0)} ms off`);
});

test('a CDJ-3000 is followed by its playhead, through jumps and pauses', () => {
  const l = link();
  const errors = play(l, { seconds: 5, positions: true, statusLagMs: 180 }).slice(100);
  assert.ok(worst(errors) <= 2, `worst error ${worst(errors).toFixed(1)} ms`);
  assert.strictEqual(l.p.getFollowed().absolute, true);

  // A loop back four beats, between beat boundaries: taken at once, whatever
  // beat the status packets still name.
  l.p._onTiming({ kind: 'position', deviceId: 1, trackLengthSec: 300, playheadMs: 3210, pitch: 0, bpm: 120 });
  assert.strictEqual(l.p.getPositionMs(), 3210);
  l.status(1, { master: true, beat: 11 });
  assert.strictEqual(l.p.getPositionMs(), 3210, 'status beat numbers do not move a deck with a playhead');

  // Paused: the playhead stands, and so does the position between packets.
  l.status(1, { master: true, beat: 7, playState: PAUSED });
  for (let i = 0; i < 10; i++) {
    l.advance(30);
    l.p._onTiming({ kind: 'position', deviceId: 1, trackLengthSec: 300, playheadMs: 3210, pitch: 0, bpm: 120 });
  }
  l.advance(20);
  assert.strictEqual(l.p.getPositionMs(), 3210);

  // Position packets stop (an older player took over the slot): status and
  // beat numbers take over again.
  l.advance(1000);
  l.status(1, { master: true, beat: 9 });
  assert.strictEqual(l.p.getFollowed().absolute, false);
  assert.strictEqual(l.p.getPositionMs(), 4000);
});

test('a deck playing in reverse runs its position backwards between packets', () => {
  const l = link();
  l.status(1, { master: true, beat: 21 });
  for (let ms = 10000; ms > 9700; ms -= 30) {
    l.p._onTiming({ kind: 'position', deviceId: 1, trackLengthSec: 300, playheadMs: ms, pitch: 0, bpm: 120 });
    l.advance(30);
  }
  const before = l.p.getPositionMs();
  l.advance(10);
  assert.ok(l.p.getPositionMs() < before, 'still going backwards');
});

// ── Two decks ─────────────────────────────────────────────────────────────────

/** Two decks reporting every 200 ms for `ms`, with the flags `a()` and `b()` return. */
function run(l, ms, a, b) {
  for (let t = 0; t < ms; t += 200) {
    if (a) l.status(1, a());
    if (b) l.status(2, b());
    l.advance(200);
  }
}

async function settled() {
  await new Promise((r) => setImmediate(r));
}

test('without a mixer, the show follows the master, and a playing deck when the master stops', async () => {
  const l = link();
  const changes = [];
  l.p.onTrackChange((track, change) => changes.push({ track: track.trackId, ...change }));
  run(l, 1000, () => ({ master: true }), () => ({}));
  await settled();
  run(l, 400, () => ({ master: true }), () => ({}));
  assert.strictEqual(l.p.getFollowed().deviceId, 1, 'both playing: the master');
  assert.deepStrictEqual(changes, [{ track: 41, handoff: false, fromPlayer: null, toPlayer: 1, overlapMs: 0 }]);

  // The master pauses; the other deck is the one making the sound.
  run(l, 600, () => ({ master: true, playState: PAUSED }), () => ({}));
  assert.strictEqual(l.p.getFollowed().deviceId, 1, 'not before the hold');
  run(l, 600, () => ({ master: true, playState: PAUSED }), () => ({}));
  assert.strictEqual(l.p.getFollowed().deviceId, 2);
  await settled();
  assert.strictEqual(changes.length, 2);
  assert.deepStrictEqual([changes[1].track, changes[1].handoff, changes[1].fromPlayer], [42, false, 1],
    'not a mix: the other deck had stopped');
});

test('in a mix, the show moves when the outgoing deck goes off air, not when a fader flickers', async () => {
  const l = link();
  const changes = [];
  l.p.onTrackChange((track, change) => changes.push({ track: track.trackId, ...change }));
  // Deck 1 is on air; deck 2 plays in the headphones.
  run(l, 2000, () => ({ master: true, onAir: true }), () => ({ onAir: false }));
  await settled();
  run(l, 200, () => ({ master: true, onAir: true }), () => ({}));
  assert.strictEqual(l.p.getFollowed().deviceId, 1);

  // Deck 2's fader comes up: both heard, the master still leads.
  run(l, 8000, () => ({ master: true, onAir: true }), () => ({ onAir: true }));
  assert.strictEqual(l.p.getFollowed().deviceId, 1);

  // A scratch flicks deck 1 off air for a moment.
  run(l, 400, () => ({ master: true, onAir: false }), () => ({ onAir: true }));
  run(l, 400, () => ({ master: true, onAir: true }), () => ({ onAir: true }));
  assert.strictEqual(l.p.getFollowed().deviceId, 1, 'a flick is not a handoff');

  // Deck 1's fader goes down for good; it is still the tempo master.
  run(l, 1200, () => ({ master: true, onAir: false }), () => ({ onAir: true }));
  assert.strictEqual(l.p.getFollowed().deviceId, 2);
  await settled();
  const handoff = changes[changes.length - 1];
  assert.deepStrictEqual([handoff.track, handoff.handoff, handoff.fromPlayer, handoff.toPlayer], [42, true, 1, 2]);
  assert.ok(handoff.overlapMs > 8000 && handoff.overlapMs < 10000, `heard together for ${handoff.overlapMs} ms`);
});

test('an ejected deck hands over at once, and every track is announced once for prefetch', async () => {
  const l = link();
  const loaded = [];
  l.p.onAnyTrackLoaded((track) => loaded.push(track.trackId));
  run(l, 600, () => ({ master: true }), () => ({}));
  await settled();
  run(l, 400, () => ({ master: true }), () => ({}));
  assert.deepStrictEqual(loaded.sort(), [41, 42]);
  assert.deepStrictEqual(l.p.getLoadedTracks().map((d) => [d.playerId, d.followed, d.master]), [[1, true, true], [2, false, false]]);

  l.status(1, { trackId: 0, playState: 0 });
  assert.strictEqual(l.p.getFollowed().deviceId, 2, 'no hold for a deck with nothing on it');
  assert.deepStrictEqual(l.p.getLoadedTracks().map((d) => d.playerId), [2]);

  // The same track loaded again is not fetched again.
  run(l, 400, () => ({ trackId: 41 }), () => ({}));
  await settled();
  assert.deepStrictEqual(loaded.sort(), [41, 42]);
});

test('the tempo reported is the followed deck\'s, pitched', () => {
  const l = link();
  const tempos = [];
  l.p.onTempoChange((bpm) => tempos.push(bpm));
  run(l, 400, () => ({ master: true, bpm: 128, pitch: 2 }), () => ({ bpm: 90 }));
  assert.deepStrictEqual(tempos.map((t) => Math.round(t * 100) / 100), [130.56]);
  assert.ok(Math.abs(l.p.getTempo() - 130.56) < 1e-9);
});
