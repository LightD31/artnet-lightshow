import dgram from 'node:dgram';
import { messageOf } from './errors.ts';

// PRO DJ LINK port 50001: magic Qspt1WmJOL; type at 0x0a; player number at 0x21.
// Beat 0x28: next beat ms at 0x24; next bar ms at 0x2c; pitch at 0x54 (0x100000 neutral);
// BPM × 100 at 0x5a; bar beat 1–4 at 0x5c.
// Position 0x0b: length seconds at 0x24; playhead ms at 0x28; signed pitch × 100 at 0x2c;
// effective BPM × 10 at 0x30, or 0xffffffff when unknown.
// Decode packet types explicitly because the library can misread beat packets as positions.
// Wire reference: https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html

export const BEAT_PORT = 50001;

const MAGIC = Buffer.from('Qspt1WmJOL', 'ascii');
const TYPE_BEAT = 0x28;
const TYPE_POSITION = 0x0b;
const BEAT_LENGTH = 0x60;
const POSITION_LENGTH = 0x34;
const PITCH_ZERO = 0x100000;

export interface BeatPacket {
  deviceId: number;
  nextBeatMs: number;
  nextBarMs: number;
  pitch: number;
  trackBpm: number | null;
  beatInBar: number;
}

export interface PositionPacket {
  deviceId: number;
  trackLengthSec: number;
  playheadMs: number;
  pitch: number;
  bpm: number | null;
}

export type TimingPacket = ({ kind: 'beat' } & BeatPacket) | ({ kind: 'position' } & PositionPacket);

function hasMagic(packet: Buffer): boolean {
  return packet.length > 0x0a && packet.subarray(0, MAGIC.length).equals(MAGIC);
}

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
  socket.on('error', (err) => console.warn(`[prolink] beat socket: ${messageOf(err)}`));
  return {
    port: socket.address().port,
    close: () => { try { socket.close(); } catch { /* already closed */ } },
  };
}
