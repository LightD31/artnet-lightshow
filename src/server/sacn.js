'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

/**
 * sACN / E1.31 output.
 *
 * Art-Net is what small nodes speak; sACN is what consoles, grandMA, Hog,
 * ETC gear and most modern nodes speak. Both carry the same 512 slots, so
 * this sits alongside artnet.js behind the same "here is a universe, put it
 * on the wire" call and either (or both) can be enabled.
 *
 * Layout is ANSI E1.31-2018 §4.1 — a 638-byte data packet:
 *
 *   0..37    Root layer      (ACN identifier, PDU length, vector, CID)
 *   38..114  Framing layer   (source name, priority, sequence, universe)
 *   115..637 DMP layer       (start code + 512 slots)
 */

const PORT = 5568;
const PACKET_SIZE = 638;
const SLOT_COUNT = 512;

// sACN universes are 1-based; Art-Net's are 0-based. Universe 0 is explicitly
// reserved in E1.31, so a frame that would land there is dropped rather than
// sent somewhere it does not belong.
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

// Options bit 6 (E1.31 §6.2.6): this source has stopped sending the universe.
const OPTION_STREAM_TERMINATED = 0x40;
// A source that stops sends three of them, in case one is lost (§6.2.6).
const TERMINATION_PACKETS = 3;

// Universe discovery (§8): the list of universes a source is sending, to its
// own multicast group every ten seconds, at most 512 universes a page.
const DISCOVERY_UNIVERSE = 64214;
const DISCOVERY_INTERVAL_MS = 10000;
const DISCOVERY_PAGE_SIZE = 512;

// The high nibble of each PDU's flags-and-length field. The low 12 bits are
// the PDU's own length, counted from its first byte to the end of the packet.
const PDU_FLAGS = 0x7000;

// Opened by the first frame, like the Art-Net socket (see artnet.js).
let udpSocket = null;
let socketReady = false;
// The local address multicast leaves from, as last applied ('' is the OS's
// choice). A machine with a show network and a house network needs to say
// which one the 239.255.x.y groups go out on.
let appliedInterface = '';
let wantedInterface = '';

/** Point multicast at a local interface, once the socket can take it. */
function applyInterface() {
  if (!socketReady || wantedInterface === appliedInterface) return;
  try {
    udpSocket.setMulticastInterface(wantedInterface || '0.0.0.0');
    appliedInterface = wantedInterface;
  } catch (err) {
    logSendFailure(new Error(`cannot send multicast from ${wantedInterface}: ${err.message}`));
    // Not retried every frame: the address is not on this machine.
    appliedInterface = wantedInterface;
  }
}

function sendSocket() {
  if (udpSocket) return udpSocket;
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Same reasoning as artnet.js: without an 'error' listener a send failure
  // becomes an unhandled event and kills the process, and the target here is
  // operator-editable while frames go out at the render rate.
  udpSocket.on('error', (err) => logSendFailure(err));

  udpSocket.bind(() => {
    socketReady = true;
    // One hop by default: a lighting network is a LAN, and a stray multicast
    // group leaking into the rest of the building helps nobody.
    try { udpSocket.setMulticastTTL(1); } catch (_) { /* not always permitted */ }
    try { udpSocket.setBroadcast(true); } catch (_) { /* nor is this */ }
    applyInterface();
  });

  // Send-only, exactly like the Art-Net socket: the HTTP listener is what
  // should keep the process alive.
  udpSocket.unref();
  return udpSocket;
}

const LOG_INTERVAL_MS = 5000;
let lastLoggedAt = 0;
let suppressedCount = 0;

function logSendFailure(err) {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_INTERVAL_MS) {
    suppressedCount++;
    return;
  }
  const extra = suppressedCount > 0 ? ` (${suppressedCount} more since last message)` : '';
  suppressedCount = 0;
  lastLoggedAt = now;
  console.warn(`[sacn] send failed: ${err.message}${extra}`);
}

/**
 * The 16-byte component identifier, from a UUID string.
 *
 * A receiver uses the CID to tell two sources apart, so it has to be stable
 * for this installation across restarts — a fresh one each boot makes the
 * console think a *new* source arrived and start arbitrating against the old
 * one. The operator's is stored in settings; a random one is generated here
 * only so an unconfigured server still emits something valid.
 */
function cidFromUuid(uuid) {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

let fallbackCid = null;
function generateCid() {
  return crypto.randomUUID();
}

function resolveCid(uuid) {
  const cid = cidFromUuid(uuid);
  if (cid) return cid;
  if (!fallbackCid) fallbackCid = cidFromUuid(generateCid());
  return fallbackCid;
}

/** The multicast group for a universe: 239.255.<high>.<low> (E1.31 §9.3.1). */
function multicastAddress(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

// One sequence counter per universe. Receivers use it to drop out-of-order
// UDP, and E1.31 wraps the full 0-255 (unlike Art-Net, where 0 means
// "sequencing disabled").
const sequences = new Map();

function nextSequence(universe) {
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
function buildE131Packet({ universe, cid, sourceName, priority, sequence, terminated = false }, dmxData) {
  const packet = Buffer.alloc(PACKET_SIZE);

  // ── Root layer ───────────────────────────────────────────────────────────
  packet.writeUInt16BE(0x0010, 0);                    // preamble size
  packet.writeUInt16BE(0x0000, 2);                    // post-amble size
  ACN_PACKET_IDENTIFIER.copy(packet, 4);
  packet.writeUInt16BE(PDU_FLAGS | (PACKET_SIZE - 16), 16);
  packet.writeUInt32BE(VECTOR_ROOT_E131_DATA, 18);
  cid.copy(packet, 22);

  // ── Framing layer ────────────────────────────────────────────────────────
  packet.writeUInt16BE(PDU_FLAGS | (PACKET_SIZE - 38), 38);
  packet.writeUInt32BE(VECTOR_E131_DATA_PACKET, 40);
  // 64 bytes, null-terminated: write at most 63 so the terminator survives.
  packet.write(String(sourceName || '').slice(0, 63), 44, 63, 'utf8');
  packet[108] = priority;
  packet.writeUInt16BE(0, 109);                       // synchronization address
  packet[111] = sequence;
  packet[112] = terminated ? OPTION_STREAM_TERMINATED : 0;   // options: never preview
  packet.writeUInt16BE(universe, 113);

  // ── DMP layer ────────────────────────────────────────────────────────────
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

/**
 * Put one universe on the wire as sACN.
 *
 * `universe` is the sACN universe, already offset from the rig's Art-Net
 * numbering by the caller. A universe outside 1–63999 is dropped: E1.31
 * reserves those, and a receiver would ignore the packet anyway.
 *
 * `terminate` says this source has stopped sending the universe: the frame
 * goes out, then three packets with the Stream_Terminated bit, so a receiver
 * lets go of this source at once instead of holding its last frame until its
 * 2.5-second timeout — and a console on the same universe takes over cleanly.
 * `iface` is the local address multicast leaves from ('' for the default).
 */
function sendSacn({ universe, cid, sourceName, priority, host, iface = '', terminate = false }, dmxData) {
  const socket = sendSocket();
  wantedInterface = iface || '';
  if (!socketReady) return false;
  applyInterface();
  if (!Number.isInteger(universe) || universe < MIN_UNIVERSE || universe > MAX_UNIVERSE) {
    return false;
  }

  // Unicast when the operator named a node, otherwise the universe's multicast
  // group — which is how sACN is normally deployed and needs no configuration.
  const target = host || multicastAddress(universe);
  const source = { universe, cid: resolveCid(cid), sourceName, priority };
  const send = (packet) => socket.send(packet, 0, packet.length, PORT, target, (err) => {
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

/**
 * The universe discovery packets for a list of universes: one per page of
 * 512, sorted, as E1.31 §8 lays them out.
 *
 *   0..37     Root layer       (vector VECTOR_ROOT_E131_EXTENDED)
 *   38..111   Framing layer    (vector VECTOR_E131_EXTENDED_DISCOVERY, name, 4 reserved)
 *   112..     Discovery layer  (vector UNIVERSE_LIST, page, last page, universes)
 */
function buildDiscoveryPackets({ cid, sourceName, universes }) {
  const sorted = [...new Set(universes)]
    .filter((u) => Number.isInteger(u) && u >= MIN_UNIVERSE && u <= MAX_UNIVERSE)
    .sort((a, b) => a - b);
  const pages = Math.max(1, Math.ceil(sorted.length / DISCOVERY_PAGE_SIZE));
  const packets = [];
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
    // 108..111 reserved, zero.

    packet.writeUInt16BE(PDU_FLAGS | (size - 112), 112);
    packet.writeUInt32BE(VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST, 114);
    packet[118] = page;
    packet[119] = pages - 1;
    list.forEach((u, i) => packet.writeUInt16BE(u, 120 + i * 2));
    packets.push(packet);
  }
  return packets;
}

/**
 * Tell the network which universes this source is sending, so a console or a
 * node's web page can list it without being told. Always to the discovery
 * group, whatever the data goes to.
 */
function sendSacnDiscovery({ cid, sourceName, universes, iface = '' }) {
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

module.exports = {
  PORT,
  PACKET_SIZE,
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
