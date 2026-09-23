import dgram from 'node:dgram';
import { messageOf } from './errors.ts';

/**
 * The two timing packets a player sends to port 50001, read straight off the
 * wire.
 *
 * alphatheta-connect reports absolute position, but it parses any packet on
 * that port whose byte 0x20 is zero as one — and a beat packet's is too, so
 * every beat of every player also arrives as a nonsense position. It does not
 * report beat packets at all. Both are small and fixed, so they are read here,
 * on a socket of our own beside the library's: it binds the port with address
 * reuse, as this does, and a broadcast reaches both.
 *
 * Every packet on the port starts with the ten-byte magic `Qspt1WmJOL`, then
 * its type at 0x0a, the sender's name, and the sender's player number at 0x21.
 *
 *   Beat (0x28), broadcast by a playing deck on every beat:
 *     0x24  ms until the next beat, at the current pitch
 *     0x2c  ms until the next bar
 *     0x54  pitch, 0x100000 = ±0 % (three bytes of a four-byte field)
 *     0x5a  BPM × 100, the track's tempo before pitch
 *     0x5c  the beat within the bar, 1–4
 *
 *   Absolute position (0x0b), every 30 ms from a CDJ-3000 with a track
 *   loaded, playing or not:
 *     0x24  track length, whole seconds
 *     0x28  playhead, ms
 *     0x2c  pitch × 100, signed
 *     0x30  effective BPM × 10, or 0xffffffff when unknown
 *
 * See https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html.
 */

export const BEAT_PORT = 50001;

const MAGIC = Buffer.from('Qspt1WmJOL', 'ascii');
const TYPE_BEAT = 0x28;
const TYPE_POSITION = 0x0b;
const BEAT_LENGTH = 0x60;
const POSITION_LENGTH = 0x34;
const PITCH_ZERO = 0x100000;

/** A deck saying a beat starts now. */
export interface BeatPacket {
  deviceId: number;
  nextBeatMs: number;
  nextBarMs: number;
  /** Percent, +8 for +8 %. */
  pitch: number;
  /** The track's tempo, before pitch. */
  trackBpm: number | null;
  beatInBar: number;
}

/** A CDJ-3000 saying exactly where its playhead is. */
export interface PositionPacket {
  deviceId: number;
  trackLengthSec: number;
  playheadMs: number;
  /** Percent, as the pitch slider shows it. */
  pitch: number;
  /** Tempo after pitch, or null when the track's is unknown. */
  bpm: number | null;
}

export type TimingPacket = ({ kind: 'beat' } & BeatPacket) | ({ kind: 'position' } & PositionPacket);

function hasMagic(packet: Buffer): boolean {
  return packet.length > 0x0a && packet.subarray(0, MAGIC.length).equals(MAGIC);
}

/** A beat or position packet, or null for anything else on the port. */
export function parseTimingPacket(packet: Buffer): TimingPacket | null {
  if (!hasMagic(packet)) return null;
  const type = packet[0x0a];
  if (type === TYPE_BEAT && packet.length >= BEAT_LENGTH) {
    const pitchRaw = packet.readUInt32BE(0x54) & 0xffffff;
    const bpmRaw = packet.readUInt16BE(0x5a);
    return {
      kind: 'beat',
      deviceId: packet[0x21],
      nextBeatMs: packet.readUInt32BE(0x24),
      nextBarMs: packet.readUInt32BE(0x2c),
      pitch: ((pitchRaw - PITCH_ZERO) / PITCH_ZERO) * 100,
      trackBpm: bpmRaw === 0xffff || bpmRaw === 0 ? null : bpmRaw / 100,
      beatInBar: packet[0x5c],
    };
  }
  if (type === TYPE_POSITION && packet.length >= POSITION_LENGTH) {
    const bpmRaw = packet.readUInt32BE(0x30);
    return {
      kind: 'position',
      deviceId: packet[0x21],
      trackLengthSec: packet.readUInt32BE(0x24),
      playheadMs: packet.readUInt32BE(0x28),
      pitch: packet.readInt32BE(0x2c) / 100,
      bpm: bpmRaw === 0xffffffff ? null : bpmRaw / 10,
    };
  }
  return null;
}

/** Build a beat packet, for tests and a simulated deck. */
export function buildBeatPacket({ deviceId, nextBeatMs, pitch = 0, trackBpm, beatInBar }:
  { deviceId: number; nextBeatMs: number; pitch?: number; trackBpm: number; beatInBar: number }): Buffer {
  const p = Buffer.alloc(BEAT_LENGTH);
  MAGIC.copy(p, 0);
  p[0x0a] = TYPE_BEAT;
  p.write('CDJ-3000', 0x0b, 'ascii');
  p[0x1f] = 0x01;
  p[0x21] = deviceId;
  p.writeUInt16BE(BEAT_LENGTH - 0x24, 0x22);
  const beatMs = 60000 / (trackBpm * (1 + pitch / 100));
  const beats = [1, 2, 4 - beatInBar + 1, 4, 4 - beatInBar + 5, 8];
  [0x24, 0x28, 0x2c, 0x30, 0x34, 0x38].forEach((at, k) => p.writeUInt32BE(k === 0 ? nextBeatMs : Math.round(nextBeatMs + (beats[k] - 1) * beatMs), at));
  p.fill(0xff, 0x3c, 0x54);
  p.writeUInt32BE(Math.round(PITCH_ZERO * (1 + pitch / 100)), 0x54);
  p.writeUInt16BE(Math.round(trackBpm * 100), 0x5a);
  p[0x5c] = beatInBar;
  p[0x5f] = deviceId;
  return p;
}

/** Build an absolute position packet, for tests and a simulated deck. */
export function buildPositionPacket({ deviceId, playheadMs, trackLengthSec = 0, pitch = 0, bpm = null }:
  { deviceId: number; playheadMs: number; trackLengthSec?: number; pitch?: number; bpm?: number | null }): Buffer {
  const p = Buffer.alloc(POSITION_LENGTH);
  MAGIC.copy(p, 0);
  p[0x0a] = TYPE_POSITION;
  p.write('CDJ-3000', 0x0b, 'ascii');
  p[0x1f] = 0x02;
  p[0x21] = deviceId;
  p.writeUInt16BE(POSITION_LENGTH - 0x24, 0x22);
  p.writeUInt32BE(trackLengthSec, 0x24);
  p.writeUInt32BE(Math.max(0, Math.round(playheadMs)), 0x28);
  p.writeInt32BE(Math.round(pitch * 100), 0x2c);
  p.writeUInt32BE(bpm == null ? 0xffffffff : Math.round(bpm * 10), 0x30);
  return p;
}

/**
 * Listen on the beat port beside alphatheta-connect. Resolves once bound;
 * `close()` releases the port.
 */
export async function listenForTiming(onPacket: (packet: TimingPacket) => void,
  { port = BEAT_PORT, address = '0.0.0.0' }: { port?: number; address?: string } = {}): Promise<{ close(): void; port: number }> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg) => {
    const packet = parseTimingPacket(msg);
    if (packet) onPacket(packet);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (err: Error) => reject(err);
    socket.once('error', failed);
    socket.bind(port, address, () => { socket.off('error', failed); resolve(); });
  });
  // Bound, a socket error is a network hiccup, not a reason to end the process.
  socket.on('error', (err) => console.warn(`[prolink] beat socket: ${messageOf(err)}`));
  return {
    port: socket.address().port,
    close: () => { try { socket.close(); } catch { /* already closed */ } },
  };
}
