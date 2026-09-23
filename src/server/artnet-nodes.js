import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

import { ARTNET_PORT, buildArtPoll, parseArtPollReply } from './artnet.js';

/**
 * The Art-Net nodes on the network, and where each universe should go.
 *
 * Out of the box the rig broadcasts to 2.255.255.255, Art-Net's traditional
 * network. On the 192.168.x network most rigs actually run on, that reaches
 * nothing, and the first night starts with a dark rig. And where a broadcast
 * does reach the nodes, it reaches every device on the network forty-four
 * times a second per universe, which is what makes Art-Net over Wi-Fi fall
 * over.
 *
 * So while the target is a broadcast address, the server asks the network who
 * is there — an ArtPoll on every interface every few seconds, as Art-Net 4
 * expects of a controller — and sends each universe a node claims straight to
 * that node. A universe nobody claims still goes to the broadcast target, so a
 * node that never answers polls (plenty don't) is driven exactly as before.
 *
 * A target that is one node's address, or this machine (a visualiser on the
 * same computer), is left exactly as it is: the operator has said where the
 * frames go, and the port this listens on is one a local visualiser may hold.
 */

const POLL_INTERVAL_MS = 3000;
// Three polls without an answer and a node is gone.
const EXPIRE_MS = 10000;

/** 32-bit number for a dotted IPv4 address. */
function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function intToIp(n) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join('.');
}

/** This machine's IPv4 interfaces: `{ name, address, netmask, broadcast }`. */
function interfaces(list = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(list || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask);
      out.push({ name, address: a.address, netmask: a.netmask, broadcast: intToIp((ip | ~mask) >>> 0) });
    }
  }
  return out;
}

/** Is this target a broadcast rather than one node? */
function isBroadcastTarget(host, ifaces = interfaces()) {
  if (!net.isIPv4(host)) return false;
  if (host === '255.255.255.255' || host.endsWith('.255')) return true;
  return ifaces.some((i) => i.broadcast === host);
}

function isLoopbackTarget(host) {
  return host === 'localhost' || (net.isIPv4(host) && host.startsWith('127.'));
}

/**
 * Who has answered, keyed by address and bind index (a node with more than
 * four ports answers once per four). Pure: time comes in as an argument.
 */
class NodeTable {
  constructor({ expireMs = EXPIRE_MS } = {}) {
    this.expireMs = expireMs;
    this._nodes = new Map();
    this._routes = null;
  }

  /** Record a reply that arrived from `from` at `at`. */
  add(reply, from, at) {
    if (!reply) return;
    const key = `${from}#${reply.bindIndex || 0}`;
    const before = this._nodes.get(key);
    this._nodes.set(key, { ...reply, from, seenAt: at });
    if (!before || before.outputs.join(',') !== reply.outputs.join(',')) this._routes = null;
  }

  _prune(at) {
    for (const [key, node] of this._nodes) {
      if (at - node.seenAt > this.expireMs) {
        this._nodes.delete(key);
        this._routes = null;
      }
    }
  }

  /** The nodes heard from lately, by address. */
  list(at) {
    this._prune(at);
    return [...this._nodes.values()].sort((a, b) => ipToInt(a.from) - ipToInt(b.from) || (a.bindIndex || 0) - (b.bindIndex || 0));
  }

  /** `{ universe: [address…] }` for every universe some node outputs. */
  routes(at) {
    this._prune(at);
    if (!this._routes) {
      const routes = {};
      for (const node of this._nodes.values()) {
        for (const universe of node.outputs) {
          const list = routes[universe] || (routes[universe] = []);
          if (!list.includes(node.from)) list.push(node.from);
        }
      }
      for (const list of Object.values(routes)) list.sort((a, b) => ipToInt(a) - ipToInt(b));
      this._routes = routes;
    }
    return this._routes;
  }

  clear() {
    this._nodes.clear();
    this._routes = null;
  }
}

/**
 * Polls the network while `shouldPoll()` says to, listening on the Art-Net
 * port for the replies. The socket is only held while polling: a rig sending
 * to one node, or to a visualiser on this machine, leaves the port alone.
 */
function createDiscovery({
  table = new NodeTable(),
  shouldPoll = () => false,
  targets = () => interfaces().map((i) => i.broadcast),
  now = Date.now,
  pollIntervalMs = POLL_INTERVAL_MS,
  port = ARTNET_PORT,
  createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
} = {}) {
  let socket = null;
  let listening = false;
  let error = null;
  let timer = null;
  const poll = buildArtPoll();

  function open() {
    if (socket) return;
    socket = createSocket();
    socket.on('error', (err) => {
      error = err.message;
      close();
    });
    socket.on('message', (msg, rinfo) => {
      const reply = parseArtPollReply(msg);
      if (reply) table.add(reply, rinfo.address, now());
    });
    socket.bind(port, () => {
      listening = true;
      error = null;
      try { socket.setBroadcast(true); } catch (_) { /* not all networks allow it */ }
      send();
    });
    if (socket.unref) socket.unref();
  }

  function close() {
    listening = false;
    if (!socket) return;
    const s = socket;
    socket = null;
    try { s.close(); } catch (_) { /* already closing */ }
  }

  function send() {
    if (!socket || !listening) return;
    const sent = new Set();
    for (const address of targets()) {
      if (!address || sent.has(address)) continue;
      sent.add(address);
      socket.send(poll, 0, poll.length, port, address, () => {});
    }
  }

  /** Once per interval: open or close to match shouldPoll, and poll. */
  function tick() {
    if (!shouldPoll()) {
      close();
      table.clear();
      return;
    }
    open();
    send();
  }

  return {
    table,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, pollIntervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      close();
    },
    /** Poll now, rather than at the next interval. */
    pollNow() { if (shouldPoll()) { open(); send(); } },
    get active() { return !!socket; },
    status() {
      return { active: !!socket, listening, error, nodes: table.list(now()) };
    },
    /** Where each claimed universe goes, while polling; null otherwise. */
    routes() { return socket ? table.routes(now()) : null; },
  };
}

export {
  POLL_INTERVAL_MS,
  EXPIRE_MS,
  NodeTable,
  createDiscovery,
  interfaces,
  isBroadcastTarget,
  isLoopbackTarget,
};
