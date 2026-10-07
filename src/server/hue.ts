import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { dtls } from 'node-dtls-client';
import { messageOf } from '../errors.ts';

/** What one bridge's session needs to stream: an entry of the settings' hue.bridges. */
export interface HueBridgeConfig {
  id: string;
  label: string;
  enabled: boolean;
  host: string;
  username: string;
  clientKey: string;
  applicationId: string;
  entertainmentId: string;
}

/** One entertainment channel's colour, 0–255 a component. */
export interface HueChannelColour {
  id: number;
  r: number;
  g: number;
  b: number;
}

export type HueState = 'idle' | 'connecting' | 'streaming' | 'failed';

export interface HueStatus {
  id: string;
  label: string;
  status: HueState;
  enabled: boolean;
  configured: boolean;
  host: string;
  entertainmentId: string;
  error: string | null;
}

/**
 * What a Hue lamp can show, from its light resource: colour (it has a gamut),
 * ambiance (a white it can tune from warm to cool) or white (a dimmer).
 */
export type LampKind = 'color' | 'ambiance' | 'white';

/** One channel of an entertainment area: a lamp, or one segment of a gradient lamp. */
export interface AreaChannel {
  id: number;
  name: string;
  position: unknown;
  /** The Hue devices that render it, to identify them. */
  devices: string[];
  /** The product, as the bridge names it ("Hue color lamp"); '' when unknown. */
  product: string;
  /** What it can show; null when the bridge would not say. */
  kind: LampKind | null;
}

/** An entertainment area, as the Rig view lists it. */
export interface EntertainmentArea {
  id: string;
  name: string;
  status: string;
  channels: AreaChannel[];
}

export type PairResult =
  | { ok: true; username: string; clientKey: string; applicationId: string }
  | { ok: false; error: string; pressLink: boolean };

interface BridgeRequest {
  method?: string;
  path: string;
  key?: string;
  body?: unknown;
  withHeaders?: boolean;
}

// The bits of the bridge's CLIP v2 answers this module reads. They come off
// the network, so every field is treated as possibly missing.
interface ClipList<T> {
  data?: T[];
}

interface ClipDevice {
  id: string;
  metadata?: { name?: string };
  product_data?: { product_name?: string };
}

interface ClipService {
  id: string;
  owner?: { rid?: string };
  /** The light this entertainment service renders through. */
  renderer_reference?: { rid?: string; rtype?: string };
}

interface ClipLight {
  id: string;
  owner?: { rid?: string };
  color?: unknown;
  color_temperature?: unknown;
}

interface ClipChannel {
  channel_id: number;
  position?: unknown;
  members?: { service?: { rid?: string } }[];
}

interface ClipEntertainmentConfig {
  id: string;
  metadata?: { name?: string };
  status?: string;
  channels?: ClipChannel[];
}

type PairReply = {
  success?: { username?: string; clientkey?: string };
  error?: { type?: number; description?: string };
}[];

interface Lamp {
  name: string;
  product: string;
  /** The device's id, which is what identify is sent to. */
  device: string;
  /** What its light can show; null when the bridge did not list the light. */
  kind: LampKind | null;
}

/**
 * Philips Hue Entertainment output.
 *
 * Art-Net and sACN put a universe on the wire and forget about it. A Hue bridge
 * is not a DMX node: it is a device you have to be *introduced* to, that hands
 * out its own credentials, and that only accepts light data over an encrypted
 * channel once you have told it — over a completely separate REST API — that a
 * streaming session is starting. So this module is three things at once:
 *
 *   1. a REST client for the bridge (discovery, pairing, entertainment areas),
 *   2. a DTLS session that carries the light data,
 *   3. the HueStream packet builder that fills it.
 *
 * Why the bridge is a special case, spelled out, because it is the thing that
 * makes this module look heavier than sacn.js:
 *
 *   - Credentials are minted by the bridge, not configured. Pairing needs the
 *     physical link button pressed, and returns two secrets: an application key
 *     (the DTLS PSK *identity*) and a client key (the PSK itself).
 *   - The data channel is DTLS 1.2 with a pre-shared key, on UDP 2100. Node has
 *     no DTLS, hence the one dependency.
 *   - A session has to be opened over REST before the first packet and closed
 *     after the last, or the bridge keeps the area locked to a stream that is
 *     no longer coming.
 *   - The bridge drops a session after roughly ten seconds of silence, so the
 *     engine's frames are also the keepalive. Nothing extra to schedule, but it
 *     does mean a stalled render loop disconnects rather than freezing the look.
 *
 * Everything above the transport is unchanged: each lamp of the area is a
 * fixture of its own, patched from the bridge (routes/fixtures.ts) with no DMX
 * address, and the show renders it as it renders any other. Its channel is
 * sent the colour it was rendered (output.ts).
 *
 * A house can have several bridges, each streaming one area: every bridge in
 * the settings has a session of its own here (HueSession), kept by its id,
 * and a frame is handed to each the channels of its own lamps.
 */

// The bridge's streaming port, fixed by the Entertainment API.
const STREAM_PORT = 2100;

// The only cipher suite a Hue bridge offers. Naming it rather than letting the
// library advertise everything keeps the ClientHello small and the handshake
// predictable — and if a firmware update ever drops it, the failure is a clear
// handshake error rather than a silently renegotiated weaker suite.
const CIPHER_SUITE = 'TLS_PSK_WITH_AES_128_GCM_SHA256' as const;

// A bridge on the LAN answers in milliseconds. This is long enough to cover a
// busy bridge and short enough that a wrong IP fails while the operator is
// still looking at the Hue section.
const REST_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;

// Philips' cloud index of bridges that have phoned home from this public IP.
// Used only as a convenience in the Rig view; a bridge can always be
// typed in by hand, and a rig on an isolated show network will have to be.
const DISCOVERY_URL = 'https://discovery.meethue.com/';

// What the bridge lists this integration as in the Hue app's "linked devices".
// The part after # is meant to identify the installation, not the product.
// The bridge refuses a devicetype past 40 characters, the application name
// past 20 or the device name past 19, as "invalid value … for parameter,
// devicetype" — see deviceType().
const DEVICE_TYPE = 'artnet-lightshow';
const DEVICE_NAME_MAX = 19;

/**
 * The devicetype to pair as: this application, and the machine it runs on
 * (`label`, its hostname) as the bridge will take it — the first part of the
 * name, in plain characters, at most 19 of them. A hostname that is only an
 * address spelled out (a reverse-DNS name such as
 * 2a02-842a-….rev.sfr.net, or 192-168-1-20.lan) says nothing in the Hue app,
 * so it pairs as "lightshow" instead.
 */
function deviceType(label: string): string {
  const first = String(label || '').split('.')[0];
  const plain = first.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, DEVICE_NAME_MAX).trim();
  const address = /^[0-9a-f-]+$/i.test(first) && /\d/.test(first);
  return `${DEVICE_TYPE}#${plain && !address ? plain : 'lightshow'}`;
}

// Hue asks for a continuous 50-60 Hz stream, repeating the last message if
// nothing changed, because the transport is lossy UDP with no retries. The
// engine renders at 44 Hz, which is close enough and keeps one frame rate in
// the system. The floor here is the ceiling that matters: it stops a faster
// render loop from ever outrunning what the bridge will accept.
//
// Note this is the *message* rate, not the effect rate. The bridge relays over
// ZigBee at a maximum of 25 Hz, so Hue's guidance is to keep effects themselves
// below about 12.5 Hz — which is a property of the show, not of this transport.
const MIN_FRAME_INTERVAL_MS = 20;

// One message carries at most 20 channel slots, and that is the protocol's
// limit rather than a suggestion: a longer message is malformed. An area cannot
// hold more than 20 lights either, so this only bites if lamps in the patch
// name channels the area does not have — which the pre-show check reports.
const MAX_CHANNELS = 20;

// ── Bridge REST ─────────────────────────────────────────────────────────────

/**
 * One JSON request to a bridge.
 *
 * TLS verification is deliberately off. A Hue bridge presents a certificate
 * issued to its bridge ID, not to the IP address you reach it on, so *every*
 * correct local connection fails standard hostname verification — there is no
 * configuration that makes it pass. The exposure is limited to the local
 * network segment the lighting rig already trusts, and the alternative (pinning
 * the Philips root CA and matching the bridge ID) buys nothing here: the
 * credentials this carries are bridge-issued and only control lamps.
 */
function bridgeRequest(host: string, options: BridgeRequest & { withHeaders: true }):
  Promise<{ body: unknown; headers: IncomingHttpHeaders }>;
function bridgeRequest(host: string, options: BridgeRequest): Promise<unknown>;
function bridgeRequest(host: string, { method = 'GET', path, key, body, withHeaders = false }: BridgeRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host,
      port: 443,
      path,
      method,
      rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(key ? { 'hue-application-key': key } : {}),
      },
      timeout: REST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {
          reject(new Error(`bridge returned ${res.statusCode} with a non-JSON body`));
          return;
        }
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(describeClipError(parsed) || `bridge returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(withHeaders ? { body: parsed, headers: res.headers } : parsed);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`no answer from ${host} within ${REST_TIMEOUT_MS}ms`)));
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** The first human-readable error out of a CLIP v2 response, if there is one. */
function describeClipError(parsed: unknown): string | null {
  const list = parsed && typeof parsed === 'object' ? (parsed as { errors?: unknown }).errors : null;
  const errors: { description?: string }[] = Array.isArray(list) ? list : [];
  if (errors.length && errors[0].description) return errors[0].description;
  return null;
}

/**
 * Bridges Philips' cloud has seen from this public IP.
 *
 * Best effort by design: it needs internet access, it only knows about bridges
 * that have checked in, and a show network usually has neither. A failure here
 * is not an error, it just means the operator types the IP in.
 */
async function discoverBridges(): Promise<{ bridges: { id: string; host: string }[]; error: string | null }> {
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!res.ok) return { bridges: [], error: `discovery service returned HTTP ${res.status}` };
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return { bridges: [], error: 'discovery service returned an unexpected body' };
    return {
      bridges: list
        .filter((b): b is { id?: string; internalipaddress: string } => b && b.internalipaddress)
        .map((b) => ({ id: b.id || '', host: b.internalipaddress })),
      error: null,
    };
  } catch (err) {
    return { bridges: [], error: messageOf(err) };
  }
}

/**
 * Ask a bridge for credentials. The link button must have been pressed within
 * the last 30 seconds.
 *
 * `generateclientkey` is what makes this different from an ordinary Hue app
 * pairing: without it the bridge returns only an application key, and the
 * entertainment stream has no PSK to hand the DTLS handshake. There is no way
 * to add one afterwards — an already-paired integration has to pair again.
 *
 * Returns { ok: true, username, clientKey } or { ok: false, error, pressLink }.
 */
async function pair(host: string, { label = 'lightshow' } = {}): Promise<PairResult> {
  let parsed: unknown;
  try {
    // The old /api endpoint, not CLIP v2: pairing is the one call that by
    // definition cannot carry an application key, and v2 has no unauthenticated
    // equivalent.
    parsed = await bridgeRequest(host, {
      method: 'POST',
      path: '/api',
      body: { devicetype: deviceType(label), generateclientkey: true },
    });
  } catch (err) {
    return { ok: false, error: messageOf(err), pressLink: false };
  }

  const first = Array.isArray(parsed) ? (parsed as PairReply)[0] : null;
  if (first && first.success && first.success.username) {
    const clientKey = first.success.clientkey || '';
    if (!clientKey) {
      return {
        ok: false,
        pressLink: false,
        error: 'The bridge paired but issued no client key, so the entertainment stream '
          + 'cannot be encrypted. This bridge is too old for the Entertainment API.',
      };
    }
    // Fetched here rather than at connect time so the whole credential set is
    // stored in one go, while we are certainly able to reach the bridge.
    const applicationId = await fetchApplicationId(host, first.success.username);
    return { ok: true, username: first.success.username, clientKey, applicationId: applicationId || '' };
  }

  // 101 is "link button not pressed", which is the overwhelmingly common
  // outcome and deserves its own answer rather than being reported as a fault.
  const error = first && first.error ? first.error : null;
  if (error && error.type === 101) {
    return {
      ok: false,
      pressLink: true,
      error: 'Press the round button on the bridge, then try again within 30 seconds.',
    };
  }
  return {
    ok: false,
    pressLink: false,
    error: (error && error.description) || 'The bridge refused the pairing request.',
  };
}

/**
 * The bridge's id for this application, which is the DTLS identity.
 *
 * Not the same thing as the application key, even though the two are issued
 * together and a bridge will often accept the key in its place. The streaming
 * API is specified against the application id — the bridge reports it in a
 * `hue-application-id` header on /auth/v1 — and it is also what shows up in an
 * entertainment area's `active_streamer` field, so it is what tells the Hue app
 * who is holding the stream.
 *
 * Returns null rather than throwing: a bridge old enough not to answer /auth/v1
 * is a bridge that still accepts the application key as the identity, and that
 * fallback should not be an error.
 */
async function fetchApplicationId(host: string, key: string): Promise<string | null> {
  try {
    const { headers } = await bridgeRequest(host, { path: '/auth/v1', key, withHeaders: true });
    const id = headers['hue-application-id'];
    return (Array.isArray(id) ? id[0] : id) || null;
  } catch (_) {
    return null;
  }
}

/**
 * The name and capabilities of every lamp that can appear in an entertainment
 * area.
 *
 * A channel does not carry a name of its own — it names the *services* that
 * render it, and the name a person recognises ("Right", "Desk lamp") lives two
 * hops away on the device that owns the service:
 *
 *   channel → members[].service (an `entertainment` resource)
 *            → owner (a `device` resource)
 *            → metadata.name
 *
 * What the lamp can show is on its `light` resource, which the entertainment
 * service points at (`renderer_reference`): a `color` block means it mixes
 * colour, a `color_temperature` block alone that it tunes white, neither that
 * it only dims. That decides the lamp's profile when it is patched, as a
 * WLED's LED count decides its own.
 *
 * All three are bulk reads, so this is three requests however many lamps
 * there are. Returns a map from entertainment service id to the lamp, and an
 * empty map on any failure: the channel ids are the truth, so a bridge that
 * will not answer these should cost a plainer table rather than an error.
 */
async function fetchLampNames(host: string, key: string): Promise<Map<string, Lamp>> {
  const names = new Map<string, Lamp>();
  try {
    const [services, devices, lights] = await Promise.all([
      bridgeRequest(host, { path: '/clip/v2/resource/entertainment', key }) as Promise<ClipList<ClipService> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/device', key }) as Promise<ClipList<ClipDevice> | null>,
      bridgeRequest(host, { path: '/clip/v2/resource/light', key }) as Promise<ClipList<ClipLight> | null>,
    ]);

    const deviceById = new Map<string, Omit<Lamp, 'kind'>>();
    for (const device of (devices && devices.data) || []) {
      deviceById.set(device.id, {
        name: (device.metadata && device.metadata.name) || '',
        product: (device.product_data && device.product_data.product_name) || '',
        device: device.id,
      });
    }
    const lightById = new Map<string, ClipLight>();
    const lightByDevice = new Map<string, ClipLight>();
    for (const light of (lights && lights.data) || []) {
      lightById.set(light.id, light);
      const owner = light.owner && light.owner.rid;
      if (owner && !lightByDevice.has(owner)) lightByDevice.set(owner, light);
    }

    for (const service of (services && services.data) || []) {
      const owner = service.owner && service.owner.rid;
      const device = owner ? deviceById.get(owner) : null;
      if (!device || !device.name) continue;
      const ref = service.renderer_reference && service.renderer_reference.rid;
      const light = (ref && lightById.get(ref)) || (owner && lightByDevice.get(owner)) || null;
      names.set(service.id, { ...device, kind: light ? kindOf(light) : null });
    }
  } catch (_) {
    return new Map();
  }
  return names;
}

/** What a light resource can show. */
function kindOf(light: Pick<ClipLight, 'color' | 'color_temperature'>): LampKind {
  if (light.color && typeof light.color === 'object') return 'color';
  if (light.color_temperature && typeof light.color_temperature === 'object') return 'ambiance';
  return 'white';
}

const KIND_RANK: Record<LampKind, number> = { white: 0, ambiance: 1, color: 2 };

/**
 * What one channel can show: the most any of its lamps can. Two lamps on one
 * channel are sent one colour, and the richer lamp is the one that shows it.
 * Null when none of its lamps could be read.
 */
function kindOfChannel(channel: ClipChannel, lamps: Map<string, Lamp>): LampKind | null {
  let best: LampKind | null = null;
  for (const member of channel.members || []) {
    const kind = lamps.get((member.service && member.service.rid) || '')?.kind;
    if (kind && (best === null || KIND_RANK[kind] > KIND_RANK[best])) best = kind;
  }
  return best;
}

/**
 * What to call one channel, from the lamps that render it.
 *
 * Usually one lamp, so usually just its name. A gradient strip or Play bar
 * spreads several channels across one device, which would otherwise give three
 * rows all called "Strip" and no way to tell which end of it you are binding —
 * so a device appearing more than once in the area has its channels numbered in
 * the order the area lists them.
 */
function nameChannel(channel: ClipChannel, names: Map<string, Lamp>, segmentCounts: Map<string, number>,
  seen: Map<string, number>): string {
  const labels: string[] = [];
  for (const member of channel.members || []) {
    const rid = member.service && member.service.rid;
    const lamp = rid ? names.get(rid) : null;
    if (!rid || !lamp) continue;
    if ((segmentCounts.get(rid) || 0) > 1) {
      const index = (seen.get(rid) || 0) + 1;
      seen.set(rid, index);
      labels.push(`${lamp.name} ${index}`);
    } else {
      labels.push(lamp.name);
    }
  }
  // Distinct names only: two members of one channel are two halves of one
  // fitting, and "Strip + Strip" says nothing.
  return [...new Set(labels)].join(' + ');
}

/**
 * The entertainment areas configured in the Hue app, with their channels.
 *
 * Areas are built in the Hue app, not here — this only reads them, because the
 * channel layout is a property of the room (which lamp is where) and the app is
 * where someone has already placed them on a floor plan.
 */
async function listEntertainmentConfigs(host: string, key: string): Promise<EntertainmentArea[]> {
  const parsed = await bridgeRequest(host, {
    path: '/clip/v2/resource/entertainment_configuration',
    key,
  }) as ClipList<ClipEntertainmentConfig> | null;
  const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
  const names = await fetchLampNames(host, key);

  return data.map((cfg) => {
    // How many channels each lamp renders in *this* area, which is what decides
    // whether its channels need numbering.
    const segmentCounts = new Map<string, number>();
    for (const ch of cfg.channels || []) {
      for (const member of ch.members || []) {
        const rid = member.service && member.service.rid;
        if (rid) segmentCounts.set(rid, (segmentCounts.get(rid) || 0) + 1);
      }
    }
    const seen = new Map<string, number>();

    return {
      id: cfg.id,
      name: (cfg.metadata && cfg.metadata.name) || cfg.id,
      status: cfg.status || 'inactive',
      channels: (cfg.channels || []).map((ch) => {
        const lamps = (ch.members || []).map((m) => names.get((m.service && m.service.rid) || '')).filter((l): l is Lamp => !!l);
        return {
          id: ch.channel_id,
          name: nameChannel(ch, names, segmentCounts, seen),
          position: ch.position || null,
          devices: [...new Set(lamps.map((l) => l.device))],
          product: [...new Set(lamps.map((l) => l.product).filter(Boolean))].join(' + '),
          kind: kindOfChannel(ch, names),
        };
      }),
    };
  });
}

/**
 * Ask Hue devices to show themselves: the bridge has each lamp breathe once
 * (CLIP v2 `identify`). A lamp in an area that is streaming follows the
 * stream instead, so a lamp bound to a fixture is identified through the
 * fixture (identify.ts) rather than through this.
 */
async function identifyDevices(host: string, key: string, devices: readonly string[]): Promise<number> {
  let sent = 0;
  for (const id of devices) {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) continue;
    await bridgeRequest(host, {
      method: 'PUT',
      path: `/clip/v2/resource/device/${encodeURIComponent(id)}`,
      key,
      body: { identify: { action: 'identify' } },
    });
    sent++;
  }
  return sent;
}

/** Open or close the bridge's streaming session for an area. */
async function setStreaming(host: string, key: string, configId: string, active: boolean): Promise<void> {
  await bridgeRequest(host, {
    method: 'PUT',
    path: `/clip/v2/resource/entertainment_configuration/${encodeURIComponent(configId)}`,
    key,
    body: { action: active ? 'start' : 'stop' },
  });
}

// ── HueStream packets ───────────────────────────────────────────────────────

const HEADER = Buffer.from('HueStream', 'ascii');    // 9 bytes
const CONFIG_ID_BYTES = 36;                          // a UUID, as ASCII
const CHANNEL_BYTES = 7;                             // id + 3 × 16-bit colour
const HEADER_BYTES = 16;

/**
 * Build one HueStream 2.0 message.
 *
 *   0..8    "HueStream"
 *   9,10    protocol version 2.0
 *   11      sequence number (the bridge ignores it; sent for packet captures)
 *   12,13   reserved
 *   14      colour space: 0 = RGB, 1 = xy + brightness
 *   15      reserved
 *   16..51  entertainment configuration id, ASCII, exactly 36 bytes
 *   52..    per channel: id, R, G, B — each colour 16-bit big-endian
 *
 * Colours arrive here as the 0–255 values the show renders and are widened by
 * ×257, which maps 0→0 and 255→65535 with even spacing (unlike <<8, which can
 * never reach full output). The extra depth is real: the bridge interpolates
 * between frames, so an 8-bit fade that would band on a DMX par does not here.
 */
function buildStreamMessage(configId: unknown, channels: readonly HueChannelColour[], sequence = 0): Buffer {
  const id = String(configId || '');
  const packet = Buffer.alloc(HEADER_BYTES + CONFIG_ID_BYTES + channels.length * CHANNEL_BYTES);

  HEADER.copy(packet, 0);
  packet[9] = 0x02;                                  // version major
  packet[10] = 0x00;                                 // version minor
  packet[11] = sequence & 0xff;
  packet[12] = 0x00;
  packet[13] = 0x00;
  packet[14] = 0x00;                                 // RGB
  packet[15] = 0x00;
  // Fixed-width and unterminated: the bridge reads exactly 36 bytes here, so a
  // short id would shift every channel that follows it.
  packet.write(id.slice(0, CONFIG_ID_BYTES).padEnd(CONFIG_ID_BYTES, '\0'), 16, CONFIG_ID_BYTES, 'ascii');

  let at = HEADER_BYTES + CONFIG_ID_BYTES;
  for (const ch of channels) {
    packet[at] = ch.id & 0xff;
    packet.writeUInt16BE(to16(ch.r), at + 1);
    packet.writeUInt16BE(to16(ch.g), at + 3);
    packet.writeUInt16BE(to16(ch.b), at + 5);
    at += CHANNEL_BYTES;
  }
  return packet;
}

/** 0–255 to 0–65535, evenly. */
function to16(value: unknown): number {
  const v = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return v * 257;
}

// ── The streaming session ───────────────────────────────────────────────────

/**
 * A Hue connection has four states and they are not interchangeable:
 *
 *   idle        nothing configured, or output turned off
 *   connecting  REST session opened, DTLS handshake in flight
 *   streaming   handshake done, frames going out
 *   failed      something went wrong; retry after a backoff
 *
 * `failed` exists so that a bridge that is off, unreachable or already being
 * streamed to by someone else does not turn every render frame into a fresh
 * handshake attempt. The engine calls sendFrame() 44 times a second and must
 * never be the thing that decides whether to reconnect.
 */
const IDLE: HueState = 'idle';
const CONNECTING: HueState = 'connecting';
const STREAMING: HueState = 'streaming';
const FAILED: HueState = 'failed';

// Back off after a failure, doubling to a ceiling. A bridge that is powered off
// should cost one attempt a minute, not forty a second — but a bridge that was
// merely mid-reboot should be picked up again quickly.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

/** Is everything needed to stream actually filled in? */
function isConfigured(c: Pick<HueBridgeConfig, 'host' | 'username' | 'clientKey' | 'entertainmentId'>): boolean {
  return !!(c.host && c.username && c.clientKey && c.entertainmentId);
}

/** Called when a session had to resolve its application id itself, so it gets stored. */
type ApplicationIdSink = (bridgeId: string, applicationId: string) => void;

/**
 * One bridge's stream: its credentials, its DTLS socket, where it is in the
 * four states above, and the backoff it has earned. A house with two bridges
 * has two of these, and nothing in one touches the other — a bridge that is
 * off keeps failing on its own schedule while the other streams.
 */
class HueSession {
  readonly id: string;
  private config: HueBridgeConfig;
  private status: HueState = IDLE;
  private socket: dtls.Socket | null = null;
  private sequence = 0;
  private lastSentAt = 0;
  private lastError: string | null = null;
  private retryAt = 0;
  private retryDelay = RETRY_BASE_MS;
  // Set while the REST "start" has been issued, so teardown knows it owes the
  // bridge a matching "stop" even if the DTLS handshake never completed.
  private sessionOpen = false;
  // Resolved once per session when the stored credentials predate this being
  // fetched at pairing time. Never persisted from here — the applier owns
  // settings — so a restart re-resolves it, which costs one request.
  private resolvedApplicationId: string | null = null;
  // The channels the last frame lit, for the dark frame that ends a stream.
  private lastChannels: number[] = [];
  private readonly sink: () => ApplicationIdSink | null;

  constructor(config: HueBridgeConfig, sink: () => ApplicationIdSink | null = () => null) {
    this.id = config.id;
    this.config = { ...config };
    this.sink = sink;
  }

  /** What to call it in a log line. */
  private get name(): string { return this.config.label || this.id; }

  getConfig(): HueBridgeConfig { return { ...this.config }; }

  isConfigured(): boolean { return isConfigured(this.config); }

  getStatus(): HueStatus {
    return {
      id: this.id,
      label: this.config.label,
      status: this.status,
      enabled: !!this.config.enabled,
      configured: this.isConfigured(),
      host: this.config.host,
      entertainmentId: this.config.entertainmentId,
      error: this.lastError,
    };
  }

  /**
   * Replace the configuration.
   *
   * Any change to where or how we connect tears the current session down: the
   * bridge would otherwise be left with a session open against the old area,
   * and it only allows one at a time, so the next start would be refused.
   */
  configure(next: Partial<HueBridgeConfig> | null | undefined): HueBridgeConfig {
    const previous = this.config;
    this.config = { ...this.config, ...next, id: this.id };

    const moved = (['host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const)
      .some((k) => previous[k] !== this.config[k]);

    // A different bridge or app key means the cached id belongs to someone else.
    if (previous.host !== this.config.host || previous.username !== this.config.username) {
      this.resolvedApplicationId = null;
    }

    if (moved || !this.config.enabled) {
      this.stop().catch(() => { /* teardown is best effort */ });
    }
    if (moved) {
      // A new target deserves an immediate attempt rather than inheriting the
      // backoff earned by the previous one.
      this.retryDelay = RETRY_BASE_MS;
      this.retryAt = 0;
      this.lastError = null;
    }
    return { ...this.config };
  }

  /**
   * Bring the session up: REST start, then DTLS handshake.
   *
   * Never awaited by the render loop — it is kicked off from sendFrame() and
   * the frames that arrive while it runs are dropped. A light show cannot
   * block on a handshake.
   */
  private async connect(): Promise<void> {
    if (this.status === CONNECTING || this.status === STREAMING) return;
    if (!this.config.enabled || !this.isConfigured()) return;

    this.status = CONNECTING;
    const config = this.config;

    // The DTLS identity is the application id. Pairings made before that was
    // fetched at pair time only have the application key stored, so resolve
    // it here and hand it back to be saved. A bridge that cannot tell us still
    // works: the key is what every older implementation used as the identity,
    // and bridges accept it.
    let identity = config.applicationId || this.resolvedApplicationId;
    if (!identity) {
      identity = await fetchApplicationId(config.host, config.username);
      if (identity) {
        this.resolvedApplicationId = identity;
        const sink = this.sink();
        if (sink) {
          try { sink(this.id, identity); } catch (_) { /* persisting is best effort */ }
        }
      } else {
        identity = config.username;
      }
    }
    // Reconfigured while the id was being fetched: that session is over.
    if (this.config !== config || this.status !== CONNECTING) return;

    try {
      await setStreaming(config.host, config.username, config.entertainmentId, true);
      this.sessionOpen = true;
    } catch (err) {
      this.fail(`could not start the entertainment session: ${messageOf(err)}`);
      return;
    }
    if (this.config !== config || this.status !== CONNECTING) {
      this.teardown();
      return;
    }

    let pending: dtls.Socket;
    try {
      pending = dtls.createSocket({
        type: 'udp4',
        address: config.host,
        port: STREAM_PORT,
        // Identity is the application id as text; the PSK is the 32-character
        // hex client key decoded to its 16 bytes. Handing the hex string
        // across as-is is the classic way to get a handshake that fails with
        // no useful diagnostic.
        psk: { [identity]: Buffer.from(config.clientKey, 'hex') },
        ciphers: [CIPHER_SUITE],
        timeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (err) {
      this.fail(`could not open the stream socket: ${messageOf(err)}`);
      return;
    }

    pending.on('connected', () => {
      // A late handshake for a session we have since torn down: drop it
      // rather than adopting a socket nobody asked for any more.
      if (this.socket !== pending) {
        try { pending.close(); } catch (_) { /* already gone */ }
        return;
      }
      this.status = STREAMING;
      this.lastError = null;
      this.retryDelay = RETRY_BASE_MS;
      console.log(`[hue] ${this.name}: streaming to ${config.host}, area ${config.entertainmentId}`);
    });

    pending.on('error', (err: Error) => {
      if (this.socket !== pending) return;
      this.fail(err.message);
    });

    pending.on('close', () => {
      if (this.socket !== pending) return;
      // Only a surprise if we thought we were streaming; a close we asked for
      // has already moved the state on.
      if (this.status === STREAMING || this.status === CONNECTING) this.fail('the bridge closed the stream');
    });

    this.socket = pending;
  }

  /** Record a failure, drop the session, and schedule the next attempt. */
  private fail(message: string): void {
    this.lastError = message;
    console.warn(`[hue] ${this.name}: ${message}`);
    this.status = FAILED;
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.teardown();
  }

  /**
   * Drop the local socket and tell the bridge the session is over.
   *
   * The REST "stop" matters more than it looks: without it the area stays
   * locked to a stream that is no longer arriving, the lamps hold their last
   * colour until the bridge's own timeout, and the Hue app shows the area as
   * busy.
   */
  private teardown(): void {
    const dying = this.socket;
    this.socket = null;
    if (dying) {
      try { dying.close(); } catch (_) { /* already gone */ }
    }
    const { host, username, entertainmentId } = this.config;
    if (this.sessionOpen && host && username && entertainmentId) {
      setStreaming(host, username, entertainmentId, false)
        .catch((err) => console.warn(`[hue] ${this.name}: could not close the session cleanly: ${messageOf(err)}`));
    }
    this.sessionOpen = false;
  }

  /** Stop streaming and stay stopped until something asks for it again. */
  async stop(): Promise<void> {
    if (this.status === IDLE && !this.socket && !this.sessionOpen) return;
    this.status = IDLE;
    this.lastError = null;
    this.teardown();
  }

  /**
   * One dark frame, then stop: the lamps go out before the bridge hands them
   * back, rather than holding the look until it does. The frame skips the
   * rate limit — it is the last one, and it has to go. What the outputs'
   * disarming does to every bridge (output.ts).
   */
  async close(): Promise<void> {
    if (this.status === STREAMING && this.socket && this.lastChannels.length) {
      this.sequence = (this.sequence + 1) & 0xff;
      const dark = this.lastChannels.map((id) => ({ id, r: 0, g: 0, b: 0 }));
      try {
        this.socket.send(buildStreamMessage(this.config.entertainmentId, dark, this.sequence), () => { /* on the way out */ });
      } catch (_) { /* the session closes regardless */ }
    }
    await this.stop();
  }

  /**
   * Put one frame of channel colours on the wire.
   *
   * Called from the render loop, so every path through it is cheap and none
   * of them throw. Returns true only when bytes actually went out, which is
   * what the caller reports as "hue" having been reached.
   */
  sendFrame(channels: readonly HueChannelColour[]): boolean {
    if (!this.config.enabled || !this.isConfigured()) return false;

    // No lamp in the patch: stay off the bridge entirely. Opening a session
    // puts the area into entertainment mode, which takes those lamps out of
    // normal Hue control — the app and any schedules stop affecting them.
    // Doing that and then sending no colours is the worst of both: the lamps
    // are seized and nothing drives them. A session already open when the
    // last lamp leaves the patch is closed for the same reason.
    if (!channels.length) {
      if (this.status === STREAMING || this.status === CONNECTING) {
        console.log(`[hue] ${this.name}: no lamp of it in the patch — releasing the entertainment area`);
        this.stop();
      }
      return false;
    }

    if (this.status === IDLE || (this.status === FAILED && Date.now() >= this.retryAt)) {
      // Fire and forget: the handshake resolves into the socket, and the
      // frames in between are simply not sent.
      this.connect().catch((err) => this.fail(messageOf(err)));
      return false;
    }
    if (this.status !== STREAMING || !this.socket) return false;

    const now = Date.now();
    if (now - this.lastSentAt < MIN_FRAME_INTERVAL_MS) return false;
    this.lastSentAt = now;

    this.sequence = (this.sequence + 1) & 0xff;
    const slots = channels.length > MAX_CHANNELS ? channels.slice(0, MAX_CHANNELS) : channels;
    this.lastChannels = slots.map((c) => c.id);
    try {
      this.socket.send(buildStreamMessage(this.config.entertainmentId, slots, this.sequence), (err) => {
        // The callback fires per datagram at the frame rate, so a bridge that
        // has gone away must not produce a log line per frame. fail() moves
        // us out of STREAMING, which stops the flood at source.
        if (err && this.status === STREAMING) this.fail(`send failed: ${err.message}`);
      });
    } catch (err) {
      this.fail(`send failed: ${messageOf(err)}`);
      return false;
    }
    return true;
  }
}

// ── The bridges ─────────────────────────────────────────────────────────────

// One session per bridge in the settings, by its id, in the settings' order.
const sessions = new Map<string, HueSession>();

/** Callback the applier sets so a lazily-fetched id gets written to settings. */
let onApplicationId: ApplicationIdSink | null = null;
function setApplicationIdSink(fn: ApplicationIdSink | null): void { onApplicationId = fn; }

/**
 * Make the sessions match the bridges in the settings: one for each, by id.
 * A bridge still there is reconfigured (which tears its stream down only if
 * something about the connection changed); one gone from the list is
 * stopped and forgotten.
 */
function configureBridges(list: readonly HueBridgeConfig[]): void {
  const keep = new Set(list.map((b) => b.id));
  for (const [id, session] of sessions) {
    if (keep.has(id)) continue;
    session.stop().catch(() => { /* best effort */ });
    sessions.delete(id);
  }
  for (const bridge of list) {
    const session = sessions.get(bridge.id);
    if (session) session.configure(bridge);
    else sessions.set(bridge.id, new HueSession(bridge, () => onApplicationId));
  }
}

function getSession(id: string): HueSession | null { return sessions.get(id) || null; }

function listSessions(): HueSession[] { return [...sessions.values()]; }

function getConfigs(): HueBridgeConfig[] { return listSessions().map((s) => s.getConfig()); }

function getStatusAll(): HueStatus[] { return listSessions().map((s) => s.getStatus()); }

/** Whether any bridge's output is on: what decides if the pars are held back. */
function anyEnabled(): boolean { return listSessions().some((s) => s.getConfig().enabled); }

/**
 * One frame for every bridge: each is sent its own channels, and a bridge
 * with none in the patch is sent an empty frame so it releases its area.
 * True when any bridge was actually reached.
 */
function sendFrames(frames: ReadonlyMap<string, readonly HueChannelColour[]>): boolean {
  let sent = false;
  for (const session of sessions.values()) {
    if (session.sendFrame(frames.get(session.id) || [])) sent = true;
  }
  return sent;
}

/** Stop every stream and stay stopped until the next frame asks again. */
async function stopAll(): Promise<void> {
  await Promise.all(listSessions().map((s) => s.stop()));
}

/** Every stream: one dark frame, then stopped — the bridges leave entertainment mode. */
async function closeAll(): Promise<void> {
  await Promise.all(listSessions().map((s) => s.close()));
}

/** Tests only — a running show has no reason to forget its sessions. */
function _reset(): void {
  sessions.clear();
  onApplicationId = null;
}

export const STATES = { IDLE, CONNECTING, STREAMING, FAILED };

export {
  STREAM_PORT,
  CIPHER_SUITE,
  MAX_CHANNELS,
  DISCOVERY_URL,
  MIN_FRAME_INTERVAL_MS,
  HEADER_BYTES,
  CONFIG_ID_BYTES,
  CHANNEL_BYTES,
  discoverBridges,
  identifyDevices,
  deviceType,
  pair,
  fetchApplicationId,
  setApplicationIdSink,
  listEntertainmentConfigs,
  fetchLampNames,
  nameChannel,
  kindOf,
  kindOfChannel,
  setStreaming,
  buildStreamMessage,
  to16,
  isConfigured,
  HueSession,
  configureBridges,
  getSession,
  listSessions,
  getConfigs,
  getStatusAll,
  anyEnabled,
  sendFrames,
  stopAll,
  closeAll,
  _reset,
};
