import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { dtls } from 'node-dtls-client';
import { messageOf } from '../errors.ts';

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

export type LampKind = 'color' | 'ambiance' | 'white';

export interface AreaChannel {
  id: number;
  name: string;
  position: unknown;
  devices: string[];
  product: string;
  kind: LampKind | null;
}

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
  device: string;
  kind: LampKind | null;
}

// Open and close Entertainment sessions around DTLS streaming so the bridge releases the area afterwards.

const STREAM_PORT = 2100;

const CIPHER_SUITE = 'TLS_PSK_WITH_AES_128_GCM_SHA256' as const;

const REST_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;

const DISCOVERY_URL = 'https://discovery.meethue.com/';

const DEVICE_TYPE = 'artnet-lightshow';
const DEVICE_NAME_MAX = 19;

function deviceType(label: string): string {
  const first = String(label || '').split('.')[0];
  const plain = first.replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, DEVICE_NAME_MAX).trim();
  const address = /^[0-9a-f-]+$/i.test(first) && /\d/.test(first);
  return `${DEVICE_TYPE}#${plain && !address ? plain : 'lightshow'}`;
}

// Limit transport messages separately from effect cadence; Zigbee relays fewer updates than the stream.
const MIN_FRAME_INTERVAL_MS = 20;

// Limit frames to 20 channels because larger HueStream messages are malformed.
const MAX_CHANNELS = 20;

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

function describeClipError(parsed: unknown): string | null {
  const list = parsed && typeof parsed === 'object' ? (parsed as { errors?: unknown }).errors : null;
  const errors: { description?: string }[] = Array.isArray(list) ? list : [];
  if (errors.length && errors[0].description) return errors[0].description;
  return null;
}

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

// Request a client key during pairing because DTLS cannot start with the application key alone.
async function pair(host: string, { label = 'lightshow' } = {}): Promise<PairResult> {
  let parsed: unknown;
  try {
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
    const applicationId = await fetchApplicationId(host, first.success.username);
    return { ok: true, username: first.success.username, clientKey, applicationId: applicationId || '' };
  }

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

async function fetchApplicationId(host: string, key: string): Promise<string | null> {
  try {
    const { headers } = await bridgeRequest(host, { path: '/auth/v1', key, withHeaders: true });
    const id = headers['hue-application-id'];
    return (Array.isArray(id) ? id[0] : id) || null;
  } catch (_) {
    return null;
  }
}

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

function kindOf(light: Pick<ClipLight, 'color' | 'color_temperature'>): LampKind {
  if (light.color && typeof light.color === 'object') return 'color';
  if (light.color_temperature && typeof light.color_temperature === 'object') return 'ambiance';
  return 'white';
}

const KIND_RANK: Record<LampKind, number> = { white: 0, ambiance: 1, color: 2 };

function kindOfChannel(channel: ClipChannel, lamps: Map<string, Lamp>): LampKind | null {
  let best: LampKind | null = null;
  for (const member of channel.members || []) {
    const kind = lamps.get((member.service && member.service.rid) || '')?.kind;
    if (kind && (best === null || KIND_RANK[kind] > KIND_RANK[best])) best = kind;
  }
  return best;
}

// Number channels from repeated devices so gradient-strip bindings remain distinguishable.
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
  return [...new Set(labels)].join(' + ');
}

// Read areas from Hue because their channel geometry is configured in the Hue app.
async function listEntertainmentConfigs(host: string, key: string): Promise<EntertainmentArea[]> {
  const parsed = await bridgeRequest(host, {
    path: '/clip/v2/resource/entertainment_configuration',
    key,
  }) as ClipList<ClipEntertainmentConfig> | null;
  const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
  const names = await fetchLampNames(host, key);

  return data.map((cfg) => {
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

async function setStreaming(host: string, key: string, configId: string, active: boolean): Promise<void> {
  await bridgeRequest(host, {
    method: 'PUT',
    path: `/clip/v2/resource/entertainment_configuration/${encodeURIComponent(configId)}`,
    key,
    body: { action: active ? 'start' : 'stop' },
  });
}

const HEADER = Buffer.from('HueStream', 'ascii');    // 9 bytes
const CONFIG_ID_BYTES = 36;                          // a UUID, as ASCII
const CHANNEL_BYTES = 7;                             // id + 3 × 16-bit colour
const HEADER_BYTES = 16;

// HueStream 2.0 byte layout:
// 0..8 HueStream; 9..10 version 2.0; 11 sequence; 12..13 reserved;
// 14 colour space (0 RGB, 1 xy+brightness); 15 reserved;
// 16..51 entertainment configuration ID, 36 ASCII bytes;
// 52.. channel ID plus 16-bit big-endian R, G, B.
// Scale bytes by 257 so 255 reaches 65535 exactly.
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

function to16(value: unknown): number {
  const v = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  return v * 257;
}

// Keep failed sessions in backoff so render frames cannot trigger repeated handshakes.
const IDLE: HueState = 'idle';
const CONNECTING: HueState = 'connecting';
const STREAMING: HueState = 'streaming';
const FAILED: HueState = 'failed';

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

function isConfigured(c: Pick<HueBridgeConfig, 'host' | 'username' | 'clientKey' | 'entertainmentId'>): boolean {
  return !!(c.host && c.username && c.clientKey && c.entertainmentId);
}

type ApplicationIdSink = (bridgeId: string, applicationId: string) => void;

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
  private sessionOpen = false;
  private resolvedApplicationId: string | null = null;
  private lastChannels: number[] = [];
  private readonly sink: () => ApplicationIdSink | null;

  constructor(config: HueBridgeConfig, sink: () => ApplicationIdSink | null = () => null) {
    this.id = config.id;
    this.config = { ...config };
    this.sink = sink;
  }

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

  // Close the old session before reconfiguration because a bridge allows only one active stream.
  configure(next: Partial<HueBridgeConfig> | null | undefined): HueBridgeConfig {
    const previous = this.config;
    this.config = { ...this.config, ...next, id: this.id };

    const moved = (['host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const)
      .some((k) => previous[k] !== this.config[k]);

    if (previous.host !== this.config.host || previous.username !== this.config.username) {
      this.resolvedApplicationId = null;
    }

    if (moved || !this.config.enabled) {
      this.stop().catch(() => { /* teardown is best effort */ });
    }
    if (moved) {
      this.retryDelay = RETRY_BASE_MS;
      this.retryAt = 0;
      this.lastError = null;
    }
    return { ...this.config };
  }

  private async connect(): Promise<void> {
    if (this.status === CONNECTING || this.status === STREAMING) return;
    if (!this.config.enabled || !this.isConfigured()) return;

    this.status = CONNECTING;
    const config = this.config;

    // Resolve the application ID for older pairings while preserving the accepted key fallback.
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
        psk: { [identity]: Buffer.from(config.clientKey, 'hex') },
        ciphers: [CIPHER_SUITE],
        timeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (err) {
      this.fail(`could not open the stream socket: ${messageOf(err)}`);
      return;
    }

    pending.on('connected', () => {
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
      if (this.status === STREAMING || this.status === CONNECTING) this.fail('the bridge closed the stream');
    });

    this.socket = pending;
  }

  private fail(message: string): void {
    this.lastError = message;
    console.warn(`[hue] ${this.name}: ${message}`);
    this.status = FAILED;
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.teardown();
  }

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

  async stop(): Promise<void> {
    if (this.status === IDLE && !this.socket && !this.sessionOpen) return;
    this.status = IDLE;
    this.lastError = null;
    this.teardown();
  }

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

  sendFrame(channels: readonly HueChannelColour[]): boolean {
    if (!this.config.enabled || !this.isConfigured()) return false;

    if (!channels.length) {
      if (this.status === STREAMING || this.status === CONNECTING) {
        console.log(`[hue] ${this.name}: no lamp of it in the patch — releasing the entertainment area`);
        this.stop();
      }
      return false;
    }

    if (this.status === IDLE || (this.status === FAILED && Date.now() >= this.retryAt)) {
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
        if (err && this.status === STREAMING) this.fail(`send failed: ${err.message}`);
      });
    } catch (err) {
      this.fail(`send failed: ${messageOf(err)}`);
      return false;
    }
    return true;
  }
}

const sessions = new Map<string, HueSession>();

let onApplicationId: ApplicationIdSink | null = null;
function setApplicationIdSink(fn: ApplicationIdSink | null): void { onApplicationId = fn; }

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

function anyEnabled(): boolean { return listSessions().some((s) => s.getConfig().enabled); }

function sendFrames(frames: ReadonlyMap<string, readonly HueChannelColour[]>): boolean {
  let sent = false;
  for (const session of sessions.values()) {
    if (session.sendFrame(frames.get(session.id) || [])) sent = true;
  }
  return sent;
}

async function stopAll(): Promise<void> {
  await Promise.all(listSessions().map((s) => s.stop()));
}

async function closeAll(): Promise<void> {
  await Promise.all(listSessions().map((s) => s.close()));
}

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
