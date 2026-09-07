'use strict';

const dgram = require('dgram');
const net = require('net');
const dns = require('dns');

const udpSocket = dgram.createSocket('udp4');

// A dgram socket with no 'error' listener turns any send failure into an
// unhandled 'error' event, which terminates the process. Since the Art-Net
// target is operator-editable and renderDmx() sends at 40 Hz, a typo in the
// settings panel used to be enough to kill the server mid-show — see AUDIT.md H1.
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
// asks for — see AUDIT.md L4.
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

module.exports = { buildArtDmxPacket, sendArtDmx };
