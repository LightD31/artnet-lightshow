import dgram from 'node:dgram';
import {
  PORT, DISCOVERY_UNIVERSE, OPTION_STREAM_TERMINATED, ACN_PACKET_IDENTIFIER,
  VECTOR_ROOT_E131_DATA, VECTOR_ROOT_E131_EXTENDED, VECTOR_E131_DATA_PACKET,
  VECTOR_E131_EXTENDED_DISCOVERY, VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST, multicastAddress,
} from './sacn.ts';

/**
 * Who else is sending sACN.
 *
 * An sACN receiver never announces itself — there is nothing to find the way
 * an Art-Net node answers a poll. What the network does carry is the sources:
 * every E1.31 source says every ten seconds which universes it sends, on the
 * universe discovery group (§8), and a source's data goes to each universe's
 * own group. So this listens to both, for a while, and says who is there: a
 * console, a media server, another copy of this — and, what matters on the
 * night, whether one of them is sending a universe this rig sends too, where
 * the higher priority wins and the other's looks vanish.
 */

/** One sACN packet, as far as this needs to read it. */
export type SacnPacket =
  | { kind: 'data'; cid: string; sourceName: string; priority: number; universe: number; terminated: boolean }
  | { kind: 'discovery'; cid: string; sourceName: string; page: number; lastPage: number; universes: number[] };

/** A source heard, by its CID. */
export interface SacnSource {
  cid: string;
  name: string;
  address: string;
  /** The priority its data carries, once any has been heard. */
  priority: number | null;
  /** The universes it says it sends (universe discovery). */
  universes: number[];
  /** The universes it was heard sending, of those listened to. */
  sending: number[];
  lastSeenAgoMs: number;
}

/** What the watch has heard, and whether it still listens. */
export interface SacnWatchStatus {
  listening: boolean;
  remainingMs: number;
  error: string | null;
  sources: SacnSource[];
  /** sACN universes another source sends too (announced or heard), with who. */
  conflicts: { universe: number; sources: string[] }[];
}

// How many universe groups to join besides discovery: every universe a rig
// of this size sends, and a bound on what one listen asks of the kernel.
const MAX_GROUPS = 64;

const cidOf = (buf: Buffer): string => {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const nameAt = (buf: Buffer, start: number): string =>
  buf.subarray(start, start + 64).toString('utf8').replace(/\0.*$/s, '').trim();

/** Read a data or universe discovery packet; null for anything else. */
export function parseSacn(buf: Buffer | null | undefined): SacnPacket | null {
  if (!buf || buf.length < 112) return null;
  if (!buf.subarray(4, 16).equals(ACN_PACKET_IDENTIFIER)) return null;
  const root = buf.readUInt32BE(18);
  const cid = cidOf(buf.subarray(22, 38));
  if (root === VECTOR_ROOT_E131_DATA) {
    if (buf.length < 126 || buf.readUInt32BE(40) !== VECTOR_E131_DATA_PACKET) return null;
    return {
      kind: 'data',
      cid,
      sourceName: nameAt(buf, 44),
      priority: buf[108],
      universe: buf.readUInt16BE(113),
      terminated: (buf[112] & OPTION_STREAM_TERMINATED) !== 0,
    };
  }
  if (root === VECTOR_ROOT_E131_EXTENDED) {
    if (buf.length < 120 || buf.readUInt32BE(40) !== VECTOR_E131_EXTENDED_DISCOVERY) return null;
    if (buf.readUInt32BE(114) !== VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST) return null;
    const end = Math.min(buf.length, 112 + (buf.readUInt16BE(112) & 0x0fff));
    const universes: number[] = [];
    for (let at = 120; at + 1 < end; at += 2) universes.push(buf.readUInt16BE(at));
    return { kind: 'discovery', cid, sourceName: nameAt(buf, 44), page: buf[118], lastPage: buf[119], universes };
  }
  return null;
}

interface Heard {
  cid: string;
  name: string;
  address: string;
  priority: number | null;
  pages: Map<number, number[]>;
  sending: Set<number>;
  lastSeen: number;
}

type WatchSocket = Pick<dgram.Socket, 'on' | 'bind' | 'close' | 'addMembership'>;

/**
 * Listen for sACN sources for a while. `listen` (again, to listen longer)
 * joins the discovery group and the groups of the universes this rig sends;
 * `status` says what was heard. Our own packets — multicast loops back —
 * are told apart by our CID and left out.
 */
export function createSacnWatch({
  createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }) as WatchSocket,
  now = () => Date.now(),
}: { createSocket?: () => WatchSocket; now?: () => number } = {}) {
  let socket: WatchSocket | null = null;
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let error: string | null = null;
  let own = '';
  const heard = new Map<string, Heard>();

  function close(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (socket) {
      try { socket.close(); } catch (_) { /* already closed */ }
    }
    socket = null;
  }

  function onMessage(msg: Buffer, rinfo: { address: string }): void {
    const packet = parseSacn(msg);
    if (!packet || packet.cid === own) return;
    let source = heard.get(packet.cid);
    if (!source) {
      source = { cid: packet.cid, name: '', address: rinfo.address, priority: null, pages: new Map(), sending: new Set(), lastSeen: 0 };
      heard.set(packet.cid, source);
    }
    source.name = packet.sourceName || source.name;
    source.address = rinfo.address;
    source.lastSeen = now();
    if (packet.kind === 'discovery') {
      // A new first page starts the list again: the source's universes changed.
      if (packet.page === 0) source.pages.clear();
      source.pages.set(packet.page, packet.universes);
    } else if (packet.terminated) {
      source.sending.delete(packet.universe);
    } else {
      source.priority = packet.priority;
      source.sending.add(packet.universe);
    }
  }

  return {
    /**
     * Listen for `seconds` more, on the discovery group and on `universes`
     * (sACN numbering). `ownCid` is this server's, to leave out; `iface` the
     * local address to join the groups on ('' for the OS's choice).
     */
    listen({ seconds = 12, universes = [], ownCid = '', iface = '' }: {
      seconds?: number; universes?: readonly number[]; ownCid?: string; iface?: string;
    } = {}): void {
      own = ownCid.toLowerCase();
      until = Math.max(until, now() + seconds * 1000);
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, Math.max(0, until - now()));
      timer.unref();
      if (socket) return;
      error = null;
      const s = createSocket();
      socket = s;
      s.on('error', (err: Error) => { error = err.message; close(); });
      s.on('message', onMessage);
      s.bind(PORT, () => {
        const groups = [DISCOVERY_UNIVERSE, ...new Set(universes)].slice(0, MAX_GROUPS + 1);
        for (const universe of groups) {
          try {
            if (iface) s.addMembership(multicastAddress(universe), iface);
            else s.addMembership(multicastAddress(universe));
          } catch (err) {
            // No multicast route, or the interface is gone: say so once.
            if (!error) error = `cannot listen on ${multicastAddress(universe)}: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      });
    },
    status(): SacnWatchStatus {
      const t = now();
      const sources: SacnSource[] = [...heard.values()].map((h) => ({
        cid: h.cid,
        name: h.name,
        address: h.address,
        priority: h.priority,
        universes: [...h.pages.keys()].sort((a, b) => a - b).flatMap((p) => h.pages.get(p) || []),
        sending: [...h.sending].sort((a, b) => a - b),
        lastSeenAgoMs: Math.max(0, t - h.lastSeen),
      })).sort((a, b) => a.name.localeCompare(b.name) || a.cid.localeCompare(b.cid));
      const byUniverse = new Map<number, string[]>();
      for (const source of sources) {
        for (const universe of new Set([...source.universes, ...source.sending])) {
          const list = byUniverse.get(universe) || [];
          list.push(source.name || source.address);
          byUniverse.set(universe, list);
        }
      }
      return {
        listening: !!socket,
        remainingMs: socket ? Math.max(0, until - t) : 0,
        error,
        sources,
        conflicts: [...byUniverse.entries()].sort((a, b) => a[0] - b[0]).map(([universe, names]) => ({ universe, sources: names })),
      };
    },
    stop: close,
  };
}

export type SacnWatch = ReturnType<typeof createSacnWatch>;
