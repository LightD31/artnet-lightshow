import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { messageOf } from '../errors.ts';

export interface SacnTarget {
  universe: number;
  cid: string;
  sourceName: string;
  priority: number;
  host: string;
  iface?: string;
  terminate?: boolean;
}

export interface E131Source {
  universe: number;
  cid: Buffer;
  sourceName: string;
  priority: number;
  sequence: number;
  terminated?: boolean;
}

// E1.31-2018 §4.1 data packet (638 bytes): root layer 0..37;
// framing layer 38..114; DMP layer 115..637 (start code and 512 DMX slots).

const PORT = 5568;
const PACKET_SIZE = 638;
const SLOT_COUNT = 512;

// Reject universe zero because E1.31 reserves it.
const MIN_UNIVERSE = 1;
const MAX_UNIVERSE = 63999;

const ACN_PACKET_IDENTIFIER = Buffer.from([
  0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00,
]);

const VECTOR_ROOT_E131_DATA = 0x00000004;
const VECTOR_ROOT_E131_EXTENDED = 0x00000008;
const VECTOR_E131_DATA_PACKET = 0x00000002;
const VECTOR_E131_EXTENDED_DISCOVERY = 0x00000002;
const VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST = 0x00000001;
const VECTOR_DMP_SET_PROPERTY = 0x02;

const OPTION_STREAM_TERMINATED = 0x40;
const TERMINATION_PACKETS = 3;

const DISCOVERY_UNIVERSE = 64214;
const DISCOVERY_INTERVAL_MS = 10000;
const DISCOVERY_PAGE_SIZE = 512;

const PDU_FLAGS = 0x7000;

let udpSocket: dgram.Socket | null = null;
let socketReady = false;
let appliedInterface = '';
let wantedInterface = '';

function applyInterface(): void {
  if (!udpSocket || !socketReady || wantedInterface === appliedInterface) return;
  try {
    udpSocket.setMulticastInterface(wantedInterface || '0.0.0.0');
    appliedInterface = wantedInterface;
  } catch (err) {
    logSendFailure(new Error(`cannot send multicast from ${wantedInterface}: ${messageOf(err)}`));
    appliedInterface = wantedInterface;
  }
}

function sendSocket(): dgram.Socket {
  if (udpSocket) return udpSocket;
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpSocket = socket;

  socket.on('error', (err) => logSendFailure(err));

  socket.bind(() => {
    socketReady = true;
    try { socket.setMulticastTTL(1); } catch (_) { /* not always permitted */ }
    try { socket.setBroadcast(true); } catch (_) { /* nor is this */ }
    applyInterface();
  });

  socket.unref();
  return socket;
}

const LOG_INTERVAL_MS = 5000;
let lastLoggedAt = 0;
let suppressedCount = 0;

function logSendFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    suppressedCount++;
    return;
  }
  const extra = suppressedCount > 0 ? ` (${suppressedCount} more since last message)` : '';
  suppressedCount = 0;
  lastLoggedAt = now;
  console.warn(`[sacn] send failed: ${messageOf(err)}${extra}`);
}

// Persist the CID so receivers recognise the same source across restarts.
function cidFromUuid(uuid: unknown): Buffer | null {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

let fallbackCid: Buffer | null = null;
function generateCid(): string {
  return crypto.randomUUID();
}

function resolveCid(uuid: unknown): Buffer {
  const cid = cidFromUuid(uuid);
  if (cid) return cid;
  if (!fallbackCid) fallbackCid = cidFromUuid(generateCid()) as Buffer;
  return fallbackCid;
}

function multicastAddress(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

const sequences = new Map<number, number>();

function nextSequence(universe: number): number {
  const next = ((sequences.get(universe) || 0) + 1) & 0xff;
  sequences.set(universe, next);
  return next;
}

/**
 * Build one E1.31 data packet.
 *
 * @param {object} opts
 * @param {number} opts.universe    sACN universe, 1–63999
 * @param {Buffer} opts.cid         16-byte component identifier
 * @param {string} opts.sourceName  shown by the receiver, truncated to 63 chars
 * @param {number} opts.priority    0–200, higher wins when sources collide
 * @param {number} opts.sequence    0–255
 * @param {Buffer} dmxData          at least 512 bytes of channel data
 */
function buildE131Packet({ universe, cid, sourceName, priority, sequence, terminated = false }: E131Source,
  dmxData: Buffer): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);

  packet.writeUInt16BE(0x0010, 0);                    // preamble size
  packet.writeUInt16BE(0x0000, 2);                    // post-amble size
  ACN_PACKET_IDENTIFIER.copy(packet, 4);
  packet.writeUInt16BE(PDU_FLAGS | (PACKET_SIZE - 16), 16);
  packet.writeUInt32BE(VECTOR_ROOT_E131_DATA, 18);
  cid.copy(packet, 22);

  packet.writeUInt16BE(PDU_FLAGS | (PACKET_SIZE - 38), 38);
  packet.writeUInt32BE(VECTOR_E131_DATA_PACKET, 40);
  // 64 bytes, null-terminated: write at most 63 so the terminator survives.
  packet.write(String(sourceName || '').slice(0, 63), 44, 63, 'utf8');
  packet[108] = priority;
  packet.writeUInt16BE(0, 109);                       // synchronization address
  packet[111] = sequence;
  packet[112] = terminated ? OPTION_STREAM_TERMINATED : 0;   // options: never preview
  packet.writeUInt16BE(universe, 113);

  packet.writeUInt16BE(PDU_FLAGS | (PACKET_SIZE - 115), 115);
  packet[117] = VECTOR_DMP_SET_PROPERTY;
  packet[118] = 0xa1;                                 // address & data type
  packet.writeUInt16BE(0x0000, 119);                  // first property address
  packet.writeUInt16BE(0x0001, 121);                  // address increment
  packet.writeUInt16BE(SLOT_COUNT + 1, 123);          // property value count: start code + slots
  packet[125] = 0x00;                                 // DMX start code
  dmxData.copy(packet, 126, 0, SLOT_COUNT);

  return packet;
}

// Send stream-termination packets when retiring a universe so receivers release it promptly.
function sendSacn({ universe, cid, sourceName, priority, host, iface = '', terminate = false }: SacnTarget,
  dmxData: Buffer): boolean {
  const socket = sendSocket();
  wantedInterface = iface || '';
  if (!socketReady) return false;
  applyInterface();
  if (!Number.isInteger(universe) || universe < MIN_UNIVERSE || universe > MAX_UNIVERSE) {
    return false;
  }

  const target = host || multicastAddress(universe);
  const source = { universe, cid: resolveCid(cid), sourceName, priority };
  const send = (packet: Buffer) => socket.send(packet, 0, packet.length, PORT, target, (err) => {
    if (err) logSendFailure(err);
  });

  send(buildE131Packet({ ...source, sequence: nextSequence(universe) }, dmxData));
  if (terminate) {
    for (let i = 0; i < TERMINATION_PACKETS; i++) {
      send(buildE131Packet({ ...source, sequence: nextSequence(universe), terminated: true }, dmxData));
    }
  }
  return true;
}

function buildDiscoveryPackets({ cid, sourceName, universes }: {
  cid: Buffer;
  sourceName: string;
  universes: Iterable<number>;
}): Buffer[] {
  const sorted = [...new Set(universes)]
    .filter((u) => Number.isInteger(u) && u >= MIN_UNIVERSE && u <= MAX_UNIVERSE)
    .sort((a, b) => a - b);
  const pages = Math.max(1, Math.ceil(sorted.length / DISCOVERY_PAGE_SIZE));
  const packets: Buffer[] = [];
  for (let page = 0; page < pages; page++) {
    const list = sorted.slice(page * DISCOVERY_PAGE_SIZE, (page + 1) * DISCOVERY_PAGE_SIZE);
    const size = 120 + list.length * 2;
    const packet = Buffer.alloc(size);

    packet.writeUInt16BE(0x0010, 0);
    packet.writeUInt16BE(0x0000, 2);
    ACN_PACKET_IDENTIFIER.copy(packet, 4);
    packet.writeUInt16BE(PDU_FLAGS | (size - 16), 16);
    packet.writeUInt32BE(VECTOR_ROOT_E131_EXTENDED, 18);
    cid.copy(packet, 22);

    packet.writeUInt16BE(PDU_FLAGS | (size - 38), 38);
    packet.writeUInt32BE(VECTOR_E131_EXTENDED_DISCOVERY, 40);
    packet.write(String(sourceName || '').slice(0, 63), 44, 63, 'utf8');

    packet.writeUInt16BE(PDU_FLAGS | (size - 112), 112);
    packet.writeUInt32BE(VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST, 114);
    packet[118] = page;
    packet[119] = pages - 1;
    list.forEach((u, i) => packet.writeUInt16BE(u, 120 + i * 2));
    packets.push(packet);
  }
  return packets;
}

// Send universe discovery to its fixed multicast group even when data is unicast.
function sendSacnDiscovery({ cid, sourceName, universes, iface = '' }: {
  cid: string;
  sourceName: string;
  universes: Iterable<number>;
  iface?: string;
}): boolean {
  const socket = sendSocket();
  wantedInterface = iface || '';
  if (!socketReady) return false;
  applyInterface();
  const target = multicastAddress(DISCOVERY_UNIVERSE);
  for (const packet of buildDiscoveryPackets({ cid: resolveCid(cid), sourceName, universes })) {
    socket.send(packet, 0, packet.length, PORT, target, (err) => {
      if (err) logSendFailure(err);
    });
  }
  return true;
}

export {
  PORT,
  PACKET_SIZE,
  ACN_PACKET_IDENTIFIER,
  VECTOR_ROOT_E131_DATA,
  VECTOR_ROOT_E131_EXTENDED,
  VECTOR_E131_DATA_PACKET,
  VECTOR_E131_EXTENDED_DISCOVERY,
  VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST,
  resolveCid,
  MIN_UNIVERSE,
  MAX_UNIVERSE,
  OPTION_STREAM_TERMINATED,
  TERMINATION_PACKETS,
  DISCOVERY_UNIVERSE,
  DISCOVERY_INTERVAL_MS,
  buildE131Packet,
  buildDiscoveryPackets,
  sendSacn,
  sendSacnDiscovery,
  multicastAddress,
  cidFromUuid,
  generateCid,
};
