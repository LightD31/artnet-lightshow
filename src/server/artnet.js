'use strict';

const dgram = require('dgram');
const net = require('net');
const dns = require('dns');

// The send socket, opened by the first frame sent rather than when this module
// loads: the engine renders in a worker thread, and the main thread (which
// loads this module for discovery and the pre-show check) has no frames to
// send and no reason to hold a socket for them.
let udpSocket = null;

function sendSocket() {
  if (udpSocket) return udpSocket;
  udpSocket = dgram.createSocket('udp4');

  // A dgram socket with no 'error' listener turns any send failure into an
  // unhandled 'error' event, which terminates the process. Since the Art-Net
  // target is operator-editable and renderDmx() sends at 44 Hz, a typo in the
  // settings panel used to be enough to kill the server mid-show.
  //
  // Failures here are also almost always transient or configuration-level
  // (unreachable host, broadcast not permitted), so the right response is to
  // log and keep rendering, not to die.
  udpSocket.on('error', (err) => logSendFailure(err));

  udpSocket.bind(() => {
    try { udpSocket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
  });

  // This socket only ever sends. The HTTP listener is what should keep the
  // server alive, so don't let a bound send-only socket hold the event loop
  // open — it otherwise stops any script that merely sends a frame from exiting.
  udpSocket.unref();
  return udpSocket;
}

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

// Art-Net sequence counters, one per universe: a receiver uses the number to
// put a universe's packets back in order, so it has to count that universe's
// packets and nobody else's. One counter shared by every universe made each
// universe's numbers jump by however many others went out in between. 0 tells
// receivers "sequencing disabled"; 1-255 wrapping is what the spec asks for.
const sequences = new Map();

function nextSequence(universe) {
  const last = sequences.get(universe) || 0;
  const next = last >= 255 ? 1 : last + 1;
  sequences.set(universe, next);
  return next;
}

function buildArtDmxPacket(universe, dmxData, seq = nextSequence(universe & 0x7fff)) {
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

const OP_SYNC = 0x5200;

/**
 * ArtSync: "output what you have been sent, now".
 *
 * A node that has seen one holds each ArtDmx it receives until the next
 * ArtSync, so every universe of a frame changes at the same instant rather
 * than one after another as their packets arrive — which on a wall of LED
 * bars spread over several universes is the difference between one movement
 * and a ripple. A node that stops receiving them goes back to outputting on
 * arrival after four seconds.
 */
function buildArtSync() {
  const packet = Buffer.alloc(14);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(OP_SYNC, 8);
  packet.writeUInt16BE(14, 10);          // protocol version
  packet[12] = 0;                        // Aux1
  packet[13] = 0;                        // Aux2
  return packet;
}

const SYNC_PACKET = buildArtSync();

/** Send an ArtSync. False when there is no address to send it to yet. */
function sendArtSync({ host, port }) {
  const address = resolveHost(host);
  if (!address) return false;
  sendSocket().send(SYNC_PACKET, 0, SYNC_PACKET.length, port, address, (err) => {
    if (err) logSendFailure(err);
  });
  return true;
}

/**
 * Queue one frame to `host`, or to each of `hosts` (the nodes that output this
 * universe). One packet, one sequence number, however many nodes get it.
 * False when there is no address to send it to yet.
 */
function sendArtDmx({ host, hosts, port, universe }, dmxData) {
  const addresses = [];
  for (const target of hosts || [host]) {
    const address = resolveHost(target);   // an unresolved host — nothing to send to yet
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  if (!addresses.length) return false;

  const packet = buildArtDmxPacket(universe, dmxData);
  // The callback keeps per-send failures out of the socket's 'error' event.
  for (const address of addresses) {
    sendSocket().send(packet, 0, packet.length, port, address, (err) => {
      if (err) logSendFailure(err);
    });
  }
  return true;
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
 * Who answered, what it calls itself, and which universes its output ports
 * are listening to. A port's universe is its Art-Net port-address: 7 bits of
 * net, 4 of subnet and 4 of universe, the last per port (SwOut). A node with
 * more than four ports answers once per group of four, told apart by its bind
 * index.
 */
function parseArtPollReply(buf) {
  if (!buf || buf.length < 207) return null;
  if (buf.subarray(0, 8).toString('ascii') !== 'Art-Net\0') return null;
  if (buf.readUInt16LE(8) !== OP_POLL_REPLY) return null;

  const trim = (start, len) => buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/s, '').trim();
  const net = buf[18] & 0x7f;
  const subnet = buf[19] & 0x0f;
  const outputs = [];
  for (let i = 0; i < 4; i++) {
    // Bit 7 of the port type: this port outputs DMX from the network.
    if (buf[174 + i] & 0x80) outputs.push((net << 8) | (subnet << 4) | (buf[190 + i] & 0x0f));
  }
  const mac = buf.length >= 207
    ? Array.from(buf.subarray(201, 207), (b) => b.toString(16).padStart(2, '0')).join(':')
    : null;

  return {
    address: `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`,
    port: buf.readUInt16LE(14),
    shortName: trim(26, 18),
    longName: trim(44, 64),
    // The universes this node outputs, and the first of them — what the
    // pre-show check names when it lists who answered.
    outputs,
    universe: outputs.length ? outputs[0] : ((net << 8) | (subnet << 4)),
    mac,
    bindIndex: buf.length > 211 ? buf[211] : 0,
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
function discoverNodes({ host, hosts = null, port = ARTNET_PORT, timeoutMs = 1500 } = {}) {
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
      const targets = [...new Set(hosts || [host])];
      let failed = 0;
      for (const target of targets) {
        socket.send(packet, 0, packet.length, port, target, (err) => {
          // A send failure is the answer: nothing will reply to a poll that
          // never left, and "network is unreachable" is exactly what preflight
          // is for. With several targets, only when none of them could be sent.
          if (err && ++failed === targets.length) finish(err.message);
        });
      }
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
  OP_POLL,
  OP_POLL_REPLY,
  OP_SYNC,
  buildArtDmxPacket,
  buildArtSync,
  sendArtSync,
  buildArtPoll,
  parseArtPollReply,
  discoverNodes,
  probeSend,
  sendArtDmx,
};
