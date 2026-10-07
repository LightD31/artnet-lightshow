import dgram from 'node:dgram';
import net from 'node:net';
import dns from 'node:dns';
import { messageOf } from '../errors.ts';

export interface ArtNode {
  address: string;
  port: number;
  shortName: string;
  longName: string;
  outputs: number[];
  universe: number;
  mac: string | null;
  bindIndex: number;
}

export interface ArtDmxTarget {
  host?: string;
  hosts?: readonly string[] | null;
  port: number;
  universe: number;
}

// Open the sender lazily so discovery-only processes do not allocate an unused socket.
let udpSocket: dgram.Socket | null = null;

function sendSocket(): dgram.Socket {
  if (udpSocket) return udpSocket;
  const socket = dgram.createSocket('udp4');
  udpSocket = socket;

  // Handle socket errors so an invalid destination cannot terminate the render loop.
  socket.on('error', (err) => logSendFailure(err));

  socket.bind(() => {
    try { socket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
  });

  // Unref the send-only socket so it cannot keep utility scripts alive.
  socket.unref();
  return socket;
}

// Rate-limit send errors so a broken target cannot bury other diagnostics.
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
  console.warn(`[artnet] send failed: ${messageOf(err)}${extra}`);
}

// Cache hostname resolution so each render frame does not trigger another DNS lookup.

const RESOLVE_TTL_MS = 60000;
const RESOLVE_RETRY_MS = 5000;
let resolved: { host: string | null; address: string | null; at: number } = { host: null, address: null, at: 0 };
let resolving = false;

function resolveHost(host: string): string | null {
  if (net.isIPv4(host)) return host;

  const now = Date.now();
  if (resolved.host === host && resolved.address && now - resolved.at < RESOLVE_TTL_MS) {
    return resolved.address;
  }

  if (!resolving && (resolved.host !== host || now - resolved.at > RESOLVE_RETRY_MS)) {
    resolving = true;
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

  return resolved.host === host ? resolved.address : null;
}

// Count sequences per universe so interleaved universes cannot create apparent packet gaps.
const sequences = new Map<number, number>();

function nextSequence(universe: number): number {
  const last = sequences.get(universe) || 0;
  const next = last >= 255 ? 1 : last + 1;
  sequences.set(universe, next);
  return next;
}

function buildArtDmxPacket(universe: number, dmxData: Buffer, seq = nextSequence(universe & 0x7fff)): Buffer {
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

// Send ArtSync after all universes so receivers present one frame together.
function buildArtSync(): Buffer {
  const packet = Buffer.alloc(14);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(OP_SYNC, 8);
  packet.writeUInt16BE(14, 10);          // protocol version
  packet[12] = 0;                        // Aux1
  packet[13] = 0;                        // Aux2
  return packet;
}

const SYNC_PACKET = buildArtSync();

function sendArtSync({ host, port }: { host: string; port: number }): boolean {
  const address = resolveHost(host);
  if (!address) return false;
  sendSocket().send(SYNC_PACKET, 0, SYNC_PACKET.length, port, address, (err) => {
    if (err) logSendFailure(err);
  });
  return true;
}

function sendArtDmx({ host, hosts, port, universe }: ArtDmxTarget, dmxData: Buffer): boolean {
  const addresses: string[] = [];
  for (const target of hosts || [host]) {
    const address = resolveHost(target as string);   // an unresolved host — nothing to send to yet
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  if (!addresses.length) return false;

  const packet = buildArtDmxPacket(universe, dmxData);
  for (const address of addresses) {
    sendSocket().send(packet, 0, packet.length, port, address, (err) => {
      if (err) logSendFailure(err);
    });
  }
  return true;
}

const ARTNET_PORT = 6454;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;

/**
 * ArtPoll: "every node, say hello".
 *
 * @param {number} talkToMe bit 1 set means "reply on change", which we do not
 *   want — a preflight should not leave nodes chattering at us afterwards.
 */
function buildArtPoll(talkToMe = 0): Buffer {
  const packet = Buffer.alloc(14);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(OP_POLL, 8);
  packet.writeUInt16BE(14, 10);         // protocol version
  packet[12] = talkToMe;
  packet[13] = 0;                       // priority: report everything
  return packet;
}

function parseArtPollReply(buf: Buffer | null | undefined): ArtNode | null {
  if (!buf || buf.length < 207) return null;
  if (buf.subarray(0, 8).toString('ascii') !== 'Art-Net\0') return null;
  if (buf.readUInt16LE(8) !== OP_POLL_REPLY) return null;

  const trim = (start: number, len: number) => buf.subarray(start, start + len).toString('latin1').replace(/\0.*$/s, '').trim();
  const net = buf[18] & 0x7f;
  const subnet = buf[19] & 0x0f;
  const outputs: number[] = [];
  for (let i = 0; i < 4; i++) {
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
    outputs,
    universe: outputs.length ? outputs[0] : ((net << 8) | (subnet << 4)),
    mac,
    bindIndex: buf.length > 211 ? buf[211] : 0,
  };
}

// Bind discovery to port 6454 because nodes reply there, not necessarily to the source port.
function discoverNodes({ host, hosts = null, port = ARTNET_PORT, timeoutMs = 1500 }: {
  host?: string;
  hosts?: readonly string[] | null;
  port?: number;
  timeoutMs?: number;
} = {}): Promise<{ nodes: (ArtNode & { from: string })[]; error: string | null }> {
  return new Promise((resolve) => {
    const nodes = new Map<string, ArtNode & { from: string }>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (error: string | null = null) => {
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
      const targets = [...new Set(hosts || [host as string])];
      let failed = 0;
      for (const target of targets) {
        socket.send(packet, 0, packet.length, port, target, (err) => {
          // Treat total send failure as the discovery result because no replies can arrive.
          if (err && ++failed === targets.length) finish(err.message);
        });
      }
    });
  });
}

const OP_ADDRESS = 0x6000;
const ADDRESS_SIZE = 107;
const NO_CHANGE = 0x7f;
const AC_LED_NORMAL = 0x02;
const AC_LED_MUTE = 0x03;
const AC_LED_LOCATE = 0x04;

function buildArtAddress(command: number, bindIndex = 1): Buffer {
  const packet = Buffer.alloc(ADDRESS_SIZE);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(OP_ADDRESS, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = NO_CHANGE;
  packet[13] = Math.max(0, Math.min(255, bindIndex | 0));
  packet.fill(NO_CHANGE, 96, 104);
  packet[104] = NO_CHANGE;
  packet[105] = 255;
  packet[106] = command & 0xff;
  return packet;
}

function sendArtAddress({ host, port = ARTNET_PORT, command, bindIndex = 1 }: {
  host: string; port?: number; command: number; bindIndex?: number;
}, timeoutMs = 2000): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* already closing */ }
      resolve({ ok: !error, error });
    };
    const timer = setTimeout(() => finish('timed out'), timeoutMs);
    timer.unref();
    socket.on('error', (err) => finish(err.message));
    socket.bind(() => {
      const packet = buildArtAddress(command, bindIndex);
      socket.send(packet, 0, packet.length, port, host, (err) => finish(err ? err.message : null));
    });
  });
}

function probeSend({ host, port, universe = 0 }: { host: string; port: number; universe?: number },
  timeoutMs = 2000): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (error: string | null) => {
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

export {
  ARTNET_PORT,
  OP_ADDRESS,
  AC_LED_NORMAL,
  AC_LED_MUTE,
  AC_LED_LOCATE,
  buildArtAddress,
  sendArtAddress,
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
