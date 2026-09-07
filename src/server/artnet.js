'use strict';

const dgram = require('dgram');
const net = require('net');
const dns = require('dns');

const udpSocket = dgram.createSocket('udp4');

// A dgram socket with no 'error' listener turns any send failure into an
// unhandled 'error' event, which terminates the process. Since the Art-Net
// target is operator-editable and renderDmx() sends at 40 Hz, a typo in the
// settings panel used to be enough to kill the server mid-show.
//
// Failures here are also almost always transient or configuration-level
// (unreachable host, broadcast not permitted), so the right response is to log
// and keep rendering, not to die.
udpSocket.on('error', (err) => logSendFailure(err));

udpSocket.bind(() => {
  try { udpSocket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
});

// This socket only ever sends. The HTTP listener is what should keep the server
// alive, so don't let a bound send-only socket hold the event loop open — it
// otherwise stops any script that merely imports this module from exiting.
udpSocket.unref();

// Art-Net output is a firehose; a broken target would otherwise produce 40
// identical log lines a second and bury everything else. Report the first
// failure immediately, then at most one line per interval.
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
  console.warn(`[artnet] send failed: ${err.message}${extra}`);
}

// ── Destination resolution ──────────────────────────────────────────────────
// dgram.send() resolves a hostname on every call, so a non-IP target meant 40
// DNS lookups per second. Resolve once per distinct host and cache it; IP
// literals (the overwhelmingly common case — Art-Net targets are addresses like
// 2.255.255.255) skip resolution entirely.

const RESOLVE_TTL_MS = 60000;
const RESOLVE_RETRY_MS = 5000;
let resolved = { host: null, address: null, at: 0 };
let resolving = false;

function resolveHost(host) {
  if (net.isIPv4(host)) return host;

  const now = Date.now();
  if (resolved.host === host && resolved.address && now - resolved.at < RESOLVE_TTL_MS) {
    return resolved.address;
  }

  if (!resolving && (resolved.host !== host || now - resolved.at > RESOLVE_RETRY_MS)) {
    resolving = true;
    // Mark the attempt now so a failing lookup backs off instead of firing on
    // every frame.
    resolved = { host, address: resolved.host === host ? resolved.address : null, at: now };
    dns.lookup(host, { family: 4 }, (err, address) => {
      resolving = false;
      if (err) {
        logSendFailure(new Error(`cannot resolve "${host}": ${err.message}`));
        return;
      }
      resolved = { host, address, at: Date.now() };
    });
  }

  // Null until the first lookup lands — frames are dropped until then, which
  // is correct: we have nowhere to send them.
  return resolved.host === host ? resolved.address : null;
}

// Art-Net sequence counter. 0 tells receivers "sequencing disabled", so they
// cannot discard out-of-order UDP packets; 1-255 wrapping is what the spec
// asks for.
let sequence = 0;

function nextSequence() {
  sequence = sequence >= 255 ? 1 : sequence + 1;
  return sequence;
}

function buildArtDmxPacket(universe, dmxData, seq = nextSequence()) {
  const packet = Buffer.alloc(18 + 512);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = seq;
  packet[13] = 0;
  packet.writeUInt16LE(universe & 0x7fff, 14);
  packet.writeUInt16BE(512, 16);
  dmxData.copy(packet, 18, 0, 512);
  return packet;
}

function sendArtDmx({ host, port, universe }, dmxData) {
  const address = resolveHost(host);
  if (!address) return;                 // unresolved host — nothing to send to yet

  const packet = buildArtDmxPacket(universe, dmxData);
  // The callback keeps per-send failures out of the socket's 'error' event.
  udpSocket.send(packet, 0, packet.length, port, address, (err) => {
    if (err) logSendFailure(err);
  });
}

// ── Discovery (ArtPoll / ArtPollReply) ──────────────────────────────────────
// Used by the preflight check, not by the render loop. "The rig looks dark" is
// a terrible way to find out that the node is on a different subnet, so ask it
// to introduce itself before doors open.

const ARTNET_PORT = 6454;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;

/**
 * ArtPoll: "every node, say hello".
 *
 * @param {number} talkToMe bit 1 set means "reply on change", which we do not
 *   want — a preflight should not leave nodes chattering at us afterwards.
 */
function buildArtPoll(talkToMe = 0) {
  const packet = Buffer.alloc(14);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(OP_POLL, 8);
  packet.writeUInt16BE(14, 10);         // protocol version
  packet[12] = talkToMe;
  packet[13] = 0;                       // priority: report everything
  return packet;
}

/**
 * Read an ArtPollReply, or null if this is not one.
 *
 * Only the fields worth showing an operator: who answered, what it calls
 * itself, and which universe it is listening on.
 */
function parseArtPollReply(buf) {
  if (!buf || buf.length < 207) return null;
  if (buf.subarray(0, 8).toString('ascii') !== 'Art-Net\0') return null;
  if (buf.readUInt16LE(8) !== OP_POLL_REPLY) return null;

  const trim = (start, len) => buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/s, '').trim();

  return {
    address: `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`,
    port: buf.readUInt16LE(14),
    shortName: trim(26, 18),
    longName: trim(44, 64),
    // Net (byte 18) and subnet/universe (byte 19) together give the 15-bit
    // universe the node's first output port is bound to.
    universe: ((buf[18] & 0x7f) << 8) | buf[19],
  };
}

/**
 * Send one ArtPoll and collect the replies.
 *
 * Binds the Art-Net port so nodes replying to 6454 (which is what the spec
 * says they do, rather than to our source port) are heard. That port is often
 * already held by another lighting tool on the same machine, which is why a
 * bind failure comes back as a result rather than a throw — it means "could not
 * ask", not "nothing is there".
 */
function discoverNodes({ host, port = ARTNET_PORT, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const nodes = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* already closing */ }
      resolve({ nodes: [...nodes.values()], error });
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    socket.on('error', (err) => finish(err.message));
    socket.on('message', (msg, rinfo) => {
      const reply = parseArtPollReply(msg);
      if (reply) nodes.set(rinfo.address, { ...reply, from: rinfo.address });
    });

    socket.bind(ARTNET_PORT, () => {
      try { socket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
      const packet = buildArtPoll();
      socket.send(packet, 0, packet.length, port, host, (err) => {
        // A send failure is the answer: nothing will reply to a poll that never
        // left, and "network is unreachable" is exactly what preflight is for.
        if (err) finish(err.message);
      });
    });
  });
}

/**
 * Try one send to the configured target and report what the OS said.
 *
 * Catches the failures that leave the rig dark with no error during a show — an
 * unreachable network, a hostname that will not resolve, broadcast refused —
 * because renderDmx() deliberately logs and carries on rather than dying.
 */
function probeSend({ host, port, universe = 0 }, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* already closing */ }
      resolve({ ok: !error, error: error || null });
    };

    const timer = setTimeout(() => finish('timed out'), timeoutMs);
    timer.unref();

    socket.on('error', (err) => finish(err.message));
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
      const packet = buildArtDmxPacket(universe, Buffer.alloc(512), 1);
      socket.send(packet, 0, packet.length, port, host, (err) => finish(err ? err.message : null));
    });
  });
}

module.exports = {
  ARTNET_PORT,
  buildArtDmxPacket,
  buildArtPoll,
  parseArtPollReply,
  discoverNodes,
  probeSend,
  sendArtDmx,
};
