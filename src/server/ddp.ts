import dgram from 'node:dgram';
import net from 'node:net';
import dns from 'node:dns';
import { messageOf } from '../errors.ts';

/**
 * DDP, the Distributed Display Protocol, as WLED speaks it.
 *
 * Art-Net and sACN carry 512-channel universes, and a pixel strip on them is
 * universe bookkeeping: 170 pixels to each. DDP carries a device's pixels as
 * one run of bytes, up to 480 RGB pixels to a packet, each packet saying where
 * in the run it starts; the last packet of a frame says "show it now".
 *
 * A packet is a ten-byte header and the data:
 *
 *   0     flags: version 1 (0x40), and push (0x01) on a frame's last packet
 *   1     sequence, 1–15 and round again (0 means "not used")
 *   2     data type: RGB (0x0B) or RGBW (0x1B), 8 bits a channel
 *   3     destination: 1, the device's display
 *   4–7   where the data starts in the run, in bytes, big-endian
 *   8–9   how many bytes follow, big-endian
 */

const DDP_PORT = 4048;
const HEADER = 10;
// 480 RGB pixels, or 360 RGBW: a whole number of either, inside one Ethernet frame.
const MAX_DATA = 1440;

const VERSION_1 = 0x40;
const PUSH = 0x01;
const TYPE_RGB = 0x0b;
const TYPE_RGBW = 0x1b;
const DISPLAY = 0x01;

/** The packets for one frame of a device's pixels: `data` from byte 0 of its run. */
function buildDdpPackets(data: Uint8Array, { sequence, rgbw = false }: { sequence: number; rgbw?: boolean }): Buffer[] {
  const packets: Buffer[] = [];
  const seq = ((sequence - 1) % 15 + 15) % 15 + 1;
  // At least one packet, so even an empty frame says "show it".
  const count = Math.max(1, Math.ceil(data.length / MAX_DATA));
  for (let k = 0; k < count; k++) {
    const offset = k * MAX_DATA;
    const length = Math.min(MAX_DATA, data.length - offset);
    const packet = Buffer.alloc(HEADER + length);
    packet[0] = VERSION_1 | (k === count - 1 ? PUSH : 0);
    packet[1] = seq;
    packet[2] = rgbw ? TYPE_RGBW : TYPE_RGB;
    packet[3] = DISPLAY;
    packet.writeUInt32BE(offset, 4);
    packet.writeUInt16BE(length, 8);
    packet.set(data.subarray(offset, offset + length), HEADER);
    packets.push(packet);
  }
  return packets;
}

/** What a packet says, for tests and a receiver: its header and its data. */
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

// ── Sending ─────────────────────────────────────────────────────────────────
// The socket opens with the first frame: the engine renders in a worker, and
// the main thread loading this module has nothing to send.

let socket: dgram.Socket | null = null;

function sendSocket(): dgram.Socket {
  if (socket) return socket;
  const s = dgram.createSocket('udp4');
  socket = s;
  // Without a listener a failed send is an unhandled 'error' that ends the
  // process; a WLED that dropped off the network is not worth a show.
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

// A hostname resolved once and kept, per device: dgram would look it up on
// every one of 44 frames a second. Frames go nowhere until it has resolved.
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

/** Send one frame of a device's pixels. False when its host has not resolved yet. */
function sendDdp({ host, port = DDP_PORT, sequence, rgbw = false }: { host: string; port?: number; sequence: number; rgbw?: boolean },
  data: Uint8Array): boolean {
  const address = resolveHost(host);
  if (!address) return false;
  const s = sendSocket();
  for (const packet of buildDdpPackets(data, { sequence, rgbw })) s.send(packet, port, address);
  return true;
}

export {
  DDP_PORT,
  MAX_DATA as DDP_MAX_DATA,
  buildDdpPackets,
  parseDdpPacket,
  sendDdp,
};
