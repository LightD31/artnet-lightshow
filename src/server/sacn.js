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
const VECTOR_E131_DATA_PACKET = 0x00000002;
const VECTOR_DMP_SET_PROPERTY = 0x02;

// The high nibble of each PDU's flags-and-length field. The low 12 bits are
// the PDU's own length, counted from its first byte to the end of the packet.
const PDU_FLAGS = 0x7000;

const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

// Same reasoning as artnet.js: without an 'error' listener a send failure
// becomes an unhandled event and kills the process, and the target here is
// operator-editable while frames go out at the render rate.
udpSocket.on('error', (err) => logSendFailure(err));

let socketReady = false;
udpSocket.bind(() => {
  socketReady = true;
  // One hop by default: a lighting network is a LAN, and a stray multicast
  // group leaking into the rest of the building helps nobody.
  try { udpSocket.setMulticastTTL(1); } catch (_) { /* not always permitted */ }
  try { udpSocket.setBroadcast(true); } catch (_) { /* nor is this */ }
});

// Send-only, exactly like the Art-Net socket: the HTTP listener is what should
// keep the process alive.
udpSocket.unref();

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
function buildE131Packet({ universe, cid, sourceName, priority, sequence }, dmxData) {
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
  packet[112] = 0;                                    // options: not preview, not terminated
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
 */
function sendSacn({ universe, cid, sourceName, priority, host }, dmxData) {
  if (!socketReady) return false;
  if (!Number.isInteger(universe) || universe < MIN_UNIVERSE || universe > MAX_UNIVERSE) {
    return false;
  }

  const packet = buildE131Packet({
    universe,
    cid: resolveCid(cid),
    sourceName,
    priority,
    sequence: nextSequence(universe),
  }, dmxData);

  // Unicast when the operator named a node, otherwise the universe's multicast
  // group — which is how sACN is normally deployed and needs no configuration.
  const target = host || multicastAddress(universe);
  udpSocket.send(packet, 0, packet.length, PORT, target, (err) => {
    if (err) logSendFailure(err);
  });
  return true;
}

module.exports = {
  PORT,
  PACKET_SIZE,
  MIN_UNIVERSE,
  MAX_UNIVERSE,
  buildE131Packet,
  sendSacn,
  multicastAddress,
  cidFromUuid,
  generateCid,
};
