import dgram from 'node:dgram';
import net from 'node:net';
import dns from 'node:dns';
import { messageOf } from '../errors.ts';

// DDP header: byte 0 version 0x40 + final-packet push 0x01; byte 1 sequence 1–15;
// byte 2 RGB 0x0B / RGBW 0x1B; byte 3 display destination 1;
// bytes 4–7 big-endian data offset; bytes 8–9 big-endian payload length.

const DDP_PORT = 4048;
const HEADER = 10;
const MAX_DATA = 1440;

const VERSION_1 = 0x40;
const PUSH = 0x01;
const TYPE_RGB = 0x0b;
const TYPE_RGBW = 0x1b;
const DISPLAY = 0x01;

export interface DdpRun {
  at: number;
  from: number;
  bytes: number;
}

// Push only the final packet so segmented devices never display a partly updated frame.
function buildDdpPackets(data: Uint8Array, { sequence, rgbw = false, runs }: { sequence: number; rgbw?: boolean; runs?: DdpRun[] }): Buffer[] {
  const packets: Buffer[] = [];
  const seq = ((sequence - 1) % 15 + 15) % 15 + 1;
  const spans = runs && runs.length ? runs : [{ at: 0, from: 0, bytes: data.length }];
  for (const span of spans) {
    const count = Math.max(1, Math.ceil(span.bytes / MAX_DATA));
    for (let k = 0; k < count; k++) {
      const offset = k * MAX_DATA;
      const length = Math.max(0, Math.min(MAX_DATA, span.bytes - offset));
      const packet = Buffer.alloc(HEADER + length);
      packet[0] = VERSION_1;
      packet[1] = seq;
      packet[2] = rgbw ? TYPE_RGBW : TYPE_RGB;
      packet[3] = DISPLAY;
      packet.writeUInt32BE(span.at + offset, 4);
      packet.writeUInt16BE(length, 8);
      packet.set(data.subarray(span.from + offset, span.from + offset + length), HEADER);
      packets.push(packet);
    }
  }
  packets[packets.length - 1][0] |= PUSH;
  return packets;
}

function parseDdpPacket(packet: Buffer): { push: boolean; sequence: number; rgbw: boolean; offset: number; data: Buffer } | null {
  if (packet.length < HEADER || (packet[0] & 0xc0) !== VERSION_1) return null;
  const length = packet.readUInt16BE(8);
  if (packet.length < HEADER + length) return null;
  return {
    push: (packet[0] & PUSH) !== 0,
    sequence: packet[1] & 0x0f,
    rgbw: ((packet[2] >> 3) & 0x07) === 0b011,
    offset: packet.readUInt32BE(4),
    data: packet.subarray(HEADER, HEADER + length),
  };
}

let socket: dgram.Socket | null = null;

function sendSocket(): dgram.Socket {
  if (socket) return socket;
  const s = dgram.createSocket('udp4');
  socket = s;
  s.on('error', (err) => logFailure(err));
  s.bind();
  s.unref();
  return s;
}

const LOG_INTERVAL_MS = 5000;
let lastLoggedAt = 0;
let suppressed = 0;

function logFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    suppressed++;
    return;
  }
  const extra = suppressed ? ` (${suppressed} more since last message)` : '';
  suppressed = 0;
  lastLoggedAt = now;
  console.warn(`[ddp] send failed: ${messageOf(err)}${extra}`);
}

const RESOLVE_TTL_MS = 60_000;
const RESOLVE_RETRY_MS = 5_000;
const resolved = new Map<string, { address: string | null; at: number; pending: boolean }>();

function resolveHost(host: string): string | null {
  if (net.isIP(host)) return host;
  const now = Date.now();
  const known = resolved.get(host);
  if (known && known.address && now - known.at < RESOLVE_TTL_MS) return known.address;
  if (!known || (!known.pending && now - known.at > (known.address ? RESOLVE_TTL_MS : RESOLVE_RETRY_MS))) {
    const entry = { address: known ? known.address : null, at: now, pending: true };
    resolved.set(host, entry);
    dns.lookup(host, { family: 4 }, (err, address) => {
      if (err) logFailure(new Error(`cannot resolve "${host}": ${err.message}`));
      resolved.set(host, { address: err ? entry.address : address, at: Date.now(), pending: false });
    });
  }
  return resolved.get(host)?.address ?? null;
}

function sendDdp({ host, port = DDP_PORT, sequence, rgbw = false, runs }: { host: string; port?: number; sequence: number; rgbw?: boolean; runs?: DdpRun[] },
  data: Uint8Array): boolean {
  const address = resolveHost(host);
  if (!address) return false;
  const s = sendSocket();
  for (const packet of buildDdpPackets(data, { sequence, rgbw, runs })) s.send(packet, port, address);
  return true;
}

export {
  DDP_PORT,
  MAX_DATA as DDP_MAX_DATA,
  buildDdpPackets,
  parseDdpPacket,
  sendDdp,
};
