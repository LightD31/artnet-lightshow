'use strict';

const https = require('https');
const { dtls } = require('node-dtls-client');

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
 * Everything above the transport is unchanged: the show renders as it always
 * did, and each Hue channel simply reads the colour of the fixture it is bound
 * to. See output.js for that mapping.
 */

// The bridge's streaming port, fixed by the Entertainment API.
const STREAM_PORT = 2100;

// The only cipher suite a Hue bridge offers. Naming it rather than letting the
// library advertise everything keeps the ClientHello small and the handshake
// predictable — and if a firmware update ever drops it, the failure is a clear
// handshake error rather than a silently renegotiated weaker suite.
const CIPHER_SUITE = 'TLS_PSK_WITH_AES_128_GCM_SHA256';

// A bridge on the LAN answers in milliseconds. This is long enough to cover a
// busy bridge and short enough that a wrong IP fails while the operator is
// still looking at the settings page.
const REST_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;

// Philips' cloud index of bridges that have phoned home from this public IP.
// Used only as a convenience in the settings page; a bridge can always be
// typed in by hand, and a rig on an isolated show network will have to be.
const DISCOVERY_URL = 'https://discovery.meethue.com/';

// What the bridge lists this integration as in the Hue app's "linked devices".
// The part after # is meant to identify the installation, not the product.
const DEVICE_TYPE = 'artnet-lightshow';

// Hue asks for a continuous 50-60 Hz stream, repeating the last message if
// nothing changed, because the transport is lossy UDP with no retries. The
// engine renders at 40 Hz, which is close enough and keeps one frame rate in
// the system. The floor here is the ceiling that matters: it stops a faster
// render loop from ever outrunning what the bridge will accept.
//
// Note this is the *message* rate, not the effect rate. The bridge relays over
// ZigBee at a maximum of 25 Hz, so Hue's guidance is to keep effects themselves
// below about 12.5 Hz — which is a property of the show, not of this transport.
const MIN_FRAME_INTERVAL_MS = 20;

// One message carries at most 20 channel slots, and that is the protocol's
// limit rather than a suggestion: a longer message is malformed. An area cannot
// hold more than 20 lights either, so this only bites if bindings name channels
// the area does not have — which the pre-show check reports separately.
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
function bridgeRequest(host, { method = 'GET', path, key, body, withHeaders = false } = {}) {
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {
          reject(new Error(`bridge returned ${res.statusCode} with a non-JSON body`));
          return;
        }
        if (res.statusCode >= 400) {
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
function describeClipError(parsed) {
  const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
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
async function discoverBridges() {
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!res.ok) return { bridges: [], error: `discovery service returned HTTP ${res.status}` };
    const list = await res.json();
    if (!Array.isArray(list)) return { bridges: [], error: 'discovery service returned an unexpected body' };
    return {
      bridges: list
        .filter((b) => b && b.internalipaddress)
        .map((b) => ({ id: b.id || '', host: b.internalipaddress })),
      error: null,
    };
  } catch (err) {
    return { bridges: [], error: err.message };
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
async function pair(host, { label = 'lightshow' } = {}) {
  let parsed;
  try {
    // The old /api endpoint, not CLIP v2: pairing is the one call that by
    // definition cannot carry an application key, and v2 has no unauthenticated
    // equivalent.
    parsed = await bridgeRequest(host, {
      method: 'POST',
      path: '/api',
      body: { devicetype: `${DEVICE_TYPE}#${label}`.slice(0, 62), generateclientkey: true },
    });
  } catch (err) {
    return { ok: false, error: err.message, pressLink: false };
  }

  const first = Array.isArray(parsed) ? parsed[0] : null;
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
async function fetchApplicationId(host, key) {
  try {
    const { headers } = await bridgeRequest(host, { path: '/auth/v1', key, withHeaders: true });
    return headers['hue-application-id'] || null;
  } catch (_) {
    return null;
  }
}

/**
 * The name of every lamp that can appear in an entertainment area.
 *
 * A channel does not carry a name of its own — it names the *services* that
 * render it, and the name a person recognises ("Right", "Desk lamp") lives two
 * hops away on the device that owns the service:
 *
 *   channel → members[].service (an `entertainment` resource)
 *            → owner (a `device` resource)
 *            → metadata.name
 *
 * Both hops are bulk reads, so this is two requests however many lamps there
 * are. Returns a map from entertainment service id to what to call it, and an
 * empty map on any failure: names make the binding table readable but the
 * channel ids are the truth, so a bridge that will not answer these should cost
 * a plainer UI rather than an error.
 */
async function fetchLampNames(host, key) {
  const names = new Map();
  try {
    const [services, devices] = await Promise.all([
      bridgeRequest(host, { path: '/clip/v2/resource/entertainment', key }),
      bridgeRequest(host, { path: '/clip/v2/resource/device', key }),
    ]);

    const deviceById = new Map();
    for (const device of (devices && devices.data) || []) {
      deviceById.set(device.id, {
        name: (device.metadata && device.metadata.name) || '',
        product: (device.product_data && device.product_data.product_name) || '',
      });
    }

    for (const service of (services && services.data) || []) {
      const owner = service.owner && service.owner.rid;
      const device = owner ? deviceById.get(owner) : null;
      if (device && device.name) names.set(service.id, device);
    }
  } catch (_) {
    return new Map();
  }
  return names;
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
function nameChannel(channel, names, segmentCounts, seen) {
  const labels = [];
  for (const member of channel.members || []) {
    const rid = member.service && member.service.rid;
    const lamp = rid ? names.get(rid) : null;
    if (!lamp) continue;
    if (segmentCounts.get(rid) > 1) {
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
async function listEntertainmentConfigs(host, key) {
  const parsed = await bridgeRequest(host, {
    path: '/clip/v2/resource/entertainment_configuration',
    key,
  });
  const data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
  const names = await fetchLampNames(host, key);

  return data.map((cfg) => {
    // How many channels each lamp renders in *this* area, which is what decides
    // whether its channels need numbering.
    const segmentCounts = new Map();
    for (const ch of cfg.channels || []) {
      for (const member of ch.members || []) {
        const rid = member.service && member.service.rid;
        if (rid) segmentCounts.set(rid, (segmentCounts.get(rid) || 0) + 1);
      }
    }
    const seen = new Map();

    return {
      id: cfg.id,
      name: (cfg.metadata && cfg.metadata.name) || cfg.id,
      status: cfg.status || 'inactive',
      channels: (cfg.channels || []).map((ch) => ({
        id: ch.channel_id,
        name: nameChannel(ch, names, segmentCounts, seen),
        position: ch.position || null,
      })),
    };
  });
}

/** Open or close the bridge's streaming session for an area. */
async function setStreaming(host, key, configId, active) {
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
function buildStreamMessage(configId, channels, sequence = 0) {
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
function to16(value) {
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
 * handshake attempt. The engine calls sendFrame() 40 times a second and must
 * never be the thing that decides whether to reconnect.
 */
const IDLE = 'idle';
const CONNECTING = 'connecting';
const STREAMING = 'streaming';
const FAILED = 'failed';

// Back off after a failure, doubling to a ceiling. A bridge that is powered off
// should cost one attempt a minute, not forty a second — but a bridge that was
// merely mid-reboot should be picked up again quickly.
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

let config = {
  enabled: false,
  host: '',
  username: '',
  clientKey: '',
  applicationId: '',
  entertainmentId: '',
};

// Resolved once per session when the stored credentials predate this being
// fetched at pairing time. Never persisted from here — the applier owns
// settings — so a restart re-resolves it, which costs one request.
let resolvedApplicationId = null;

/** Callback the applier sets so a lazily-fetched id gets written to settings. */
let onApplicationId = null;
function setApplicationIdSink(fn) { onApplicationId = fn; }

let status = IDLE;
let socket = null;
let sequence = 0;
let lastSentAt = 0;
let lastError = null;
let retryAt = 0;
let retryDelay = RETRY_BASE_MS;
// Set while the REST "start" has been issued, so teardown knows it owes the
// bridge a matching "stop" even if the DTLS handshake never completed.
let sessionOpen = false;

/** Is everything needed to stream actually filled in? */
function isConfigured(c = config) {
  return !!(c.host && c.username && c.clientKey && c.entertainmentId);
}

function getStatus() {
  return {
    status,
    enabled: !!config.enabled,
    configured: isConfigured(),
    host: config.host,
    entertainmentId: config.entertainmentId,
    error: lastError,
  };
}

/**
 * Replace the configuration.
 *
 * Any change to where or how we connect tears the current session down: the
 * bridge would otherwise be left with a session open against the old area, and
 * it only allows one at a time, so the next start would be refused.
 */
function configure(next) {
  const previous = config;
  config = { ...config, ...next };

  const moved = ['host', 'username', 'clientKey', 'applicationId', 'entertainmentId']
    .some((k) => previous[k] !== config[k]);

  // A different bridge or app key means the cached id belongs to someone else.
  if (previous.host !== config.host || previous.username !== config.username) {
    resolvedApplicationId = null;
  }

  if (moved || !config.enabled) {
    stop().catch(() => { /* teardown is best effort */ });
  }
  if (moved) {
    // A new target deserves an immediate attempt rather than inheriting the
    // backoff earned by the previous one.
    retryDelay = RETRY_BASE_MS;
    retryAt = 0;
    lastError = null;
  }
  return { ...config };
}

function getConfig() { return { ...config }; }

/**
 * Bring the session up: REST start, then DTLS handshake.
 *
 * Never awaited by the render loop — it is kicked off from sendFrame() and the
 * frames that arrive while it runs are dropped. A light show cannot block on a
 * handshake.
 */
async function connect() {
  if (status === CONNECTING || status === STREAMING) return;
  if (!config.enabled || !isConfigured()) return;

  status = CONNECTING;

  // The DTLS identity is the application id. Pairings made before that was
  // fetched at pair time only have the application key stored, so resolve it
  // here and hand it back to be saved. A bridge that cannot tell us still
  // works: the key is what every older implementation used as the identity, and
  // bridges accept it.
  let identity = config.applicationId || resolvedApplicationId;
  if (!identity) {
    identity = await fetchApplicationId(config.host, config.username);
    if (identity) {
      resolvedApplicationId = identity;
      if (onApplicationId) {
        try { onApplicationId(identity); } catch (_) { /* persisting is best effort */ }
      }
    } else {
      identity = config.username;
    }
  }

  try {
    await setStreaming(config.host, config.username, config.entertainmentId, true);
    sessionOpen = true;
  } catch (err) {
    fail(`could not start the entertainment session: ${err.message}`);
    return;
  }

  let pending;
  try {
    pending = dtls.createSocket({
      type: 'udp4',
      address: config.host,
      port: STREAM_PORT,
      // Identity is the application id as text; the PSK is the 32-character hex
      // client key decoded to its 16 bytes. Handing the hex string across as-is
      // is the classic way to get a handshake that fails with no useful
      // diagnostic.
      psk: { [identity]: Buffer.from(config.clientKey, 'hex') },
      ciphers: [CIPHER_SUITE],
      timeout: HANDSHAKE_TIMEOUT_MS,
    });
  } catch (err) {
    fail(`could not open the stream socket: ${err.message}`);
    return;
  }

  pending.on('connected', () => {
    // A late handshake for a session we have since torn down: drop it rather
    // than adopting a socket nobody asked for any more.
    if (socket !== pending) {
      try { pending.close(); } catch (_) { /* already gone */ }
      return;
    }
    status = STREAMING;
    lastError = null;
    retryDelay = RETRY_BASE_MS;
    console.log(`[hue] streaming to ${config.host}, area ${config.entertainmentId}`);
  });

  pending.on('error', (err) => {
    if (socket !== pending) return;
    fail(err.message);
  });

  pending.on('close', () => {
    if (socket !== pending) return;
    // Only a surprise if we thought we were streaming; a close we asked for has
    // already moved the state on.
    if (status === STREAMING || status === CONNECTING) fail('the bridge closed the stream');
  });

  socket = pending;
}

/** Record a failure, drop the session, and schedule the next attempt. */
function fail(message) {
  lastError = message;
  console.warn(`[hue] ${message}`);
  status = FAILED;
  retryAt = Date.now() + retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  teardown();
}

/**
 * Drop the local socket and tell the bridge the session is over.
 *
 * The REST "stop" matters more than it looks: without it the area stays locked
 * to a stream that is no longer arriving, the lamps hold their last colour
 * until the bridge's own timeout, and the Hue app shows the area as busy.
 */
function teardown() {
  const dying = socket;
  socket = null;
  if (dying) {
    try { dying.close(); } catch (_) { /* already gone */ }
  }
  if (sessionOpen && config.host && config.username && config.entertainmentId) {
    setStreaming(config.host, config.username, config.entertainmentId, false)
      .catch((err) => console.warn(`[hue] could not close the session cleanly: ${err.message}`));
  }
  sessionOpen = false;
}

/** Stop streaming and stay stopped until something asks for it again. */
async function stop() {
  if (status === IDLE && !socket && !sessionOpen) return;
  status = IDLE;
  lastError = null;
  teardown();
}

/**
 * Put one frame of channel colours on the wire.
 *
 * Called from the render loop, so every path through it is cheap and none of
 * them throw. Returns true only when bytes actually went out, which is what the
 * caller reports as "hue" having been reached.
 *
 * @param {Array<{id:number,r:number,g:number,b:number}>} channels
 */
function sendFrame(channels) {
  if (!config.enabled || !isConfigured()) return false;

  // Nothing bound: stay off the bridge entirely. Opening a session puts the
  // area into entertainment mode, which takes those lamps out of normal Hue
  // control — the app and any schedules stop affecting them. Doing that and
  // then sending no colours is the worst of both: the lamps are seized and
  // nothing drives them. A session already open when the last binding goes away
  // is closed for the same reason.
  if (!channels.length) {
    if (status === STREAMING || status === CONNECTING) {
      console.log('[hue] no channels bound — releasing the entertainment area');
      stop();
    }
    return false;
  }

  if (status === IDLE || (status === FAILED && Date.now() >= retryAt)) {
    // Fire and forget: the handshake resolves into the socket, and the frames
    // in between are simply not sent.
    connect().catch((err) => fail(err.message));
    return false;
  }
  if (status !== STREAMING || !socket) return false;

  const now = Date.now();
  if (now - lastSentAt < MIN_FRAME_INTERVAL_MS) return false;
  lastSentAt = now;

  sequence = (sequence + 1) & 0xff;
  const slots = channels.length > MAX_CHANNELS ? channels.slice(0, MAX_CHANNELS) : channels;
  try {
    socket.send(buildStreamMessage(config.entertainmentId, slots, sequence), (err) => {
      // The callback fires per datagram at the frame rate, so a bridge that has
      // gone away must not produce a log line per frame. fail() moves us out of
      // STREAMING, which stops the flood at source.
      if (err && status === STREAMING) fail(`send failed: ${err.message}`);
    });
  } catch (err) {
    fail(`send failed: ${err.message}`);
    return false;
  }
  return true;
}

/** Tests only — a running show has no reason to forget its session. */
function _reset() {
  socket = null;
  sessionOpen = false;
  status = IDLE;
  lastError = null;
  lastSentAt = 0;
  retryAt = 0;
  retryDelay = RETRY_BASE_MS;
  sequence = 0;
  config = { enabled: false, host: '', username: '', clientKey: '', applicationId: '', entertainmentId: '' };
  resolvedApplicationId = null;
  onApplicationId = null;
}

module.exports = {
  STREAM_PORT,
  CIPHER_SUITE,
  MAX_CHANNELS,
  DISCOVERY_URL,
  MIN_FRAME_INTERVAL_MS,
  HEADER_BYTES,
  CONFIG_ID_BYTES,
  CHANNEL_BYTES,
  STATES: { IDLE, CONNECTING, STREAMING, FAILED },
  discoverBridges,
  pair,
  fetchApplicationId,
  setApplicationIdSink,
  listEntertainmentConfigs,
  fetchLampNames,
  nameChannel,
  setStreaming,
  buildStreamMessage,
  to16,
  configure,
  getConfig,
  getStatus,
  isConfigured,
  sendFrame,
  stop,
  _reset,
};
