'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { SYNC_OFFSET_LIMIT_MS } = require('./presets');

/**
 * Persisted configuration, owned by the settings page.
 *
 * Everything the operator can configure lives here and is edited in the UI, not
 * in the environment. `process.env` is deliberately NOT consulted: a value is
 * either stored in settings.json or it is the default below. That means one
 * place to look when a setting isn't doing what you expect, and a settings page
 * that always shows the truth rather than whatever a shell happened to export.
 *
 * (Legacy env vars are detected at startup only to warn that they are ignored —
 * see warnAboutLegacyEnv(). Nothing reads them for their value.)
 *
 * The file holds secrets (Spotify client secret, Deezer ARL, the access token),
 * so it is written 0600 and must stay out of version control.
 */

const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 3000,
    token: '',
    publicUrl: '',
  },
  artnet: {
    enabled: true,
    host: '2.255.255.255',
    port: 6454,
    universe: 0,
  },
  // sACN / E1.31: what consoles and most modern nodes speak. Off by default —
  // enabling it is a deliberate act, and a rig can run it alongside Art-Net or
  // instead of it.
  sacn: {
    enabled: false,
    // Blank multicasts to each universe's own group (239.255.x.y), which is how
    // sACN is normally deployed. Name a node to unicast to it instead.
    host: '',
    priority: 100,
    sourceName: 'ArtNet Lightshow',
    // Art-Net counts universes from 0, sACN from 1. The default lines them up.
    universeOffset: 1,
    // Stable per installation: a receiver tells sources apart by CID, so a
    // fresh one each boot reads as a second source arriving. Generated on
    // first start and stored here.
    cid: '',
  },
  // Philips Hue Entertainment. Off by default: it needs credentials the bridge
  // itself has to issue, so there is nothing sensible to default to. Unlike
  // Art-Net and sACN this does not carry a universe — each Hue channel is bound
  // to a rig fixture and shows that fixture's colour.
  hue: {
    enabled: false,
    // The bridge's address. Found for you in the settings page, or typed in
    // when the show network has no route to Philips' discovery service.
    host: '',
    // Both issued by the bridge during pairing, never typed by anyone: the
    // application key is the DTLS identity, the client key is the pre-shared
    // key itself. Secrets, so they are write-only from the UI's point of view.
    username: '',
    clientKey: '',
    // The bridge's id for this application, which is what the DTLS handshake
    // uses as its identity. Issued alongside the keys and fetched during
    // pairing; resolved on first connect for pairings made before that.
    applicationId: '',
    // Which entertainment area to drive. Areas are built in the Hue app, since
    // that is where the lamps have already been placed on a floor plan.
    entertainmentId: '',
    // Which fixture each Hue channel follows: [{ channel, fixture }]. A channel
    // with no binding is simply not sent, which leaves the bridge holding its
    // last value for that lamp rather than forcing it black.
    channels: [],
  },
  midi: {
    input: '',
    output: '',
    // Drive motorised faders and encoder LED rings back to the show's state.
    // Harmless on a controller without them — it ignores the CC — but a MIDI
    // loopback would echo our feedback in as operator input, so it is a switch.
    controlFeedback: true,
  },
  sources: {
    prolink: false,
    smtc: true,
  },
  spotify: {
    clientId: '',
    clientSecret: '',
    // The connected session. Written by the server when Spotify issues or
    // rotates it, never typed by anyone, so it has no field in the settings
    // page — but it is a credential, so it is a secret path like the rest.
    refreshToken: '',
    // Blank: authorise straight against Spotify using a 127.0.0.1 redirect,
    // which Spotify allows and which needs no third party. Set a relay here
    // only to authorise from a device other than the one running the server.
    proxyBase: '',
    allowUnverifiedState: false,
  },
  deezer: {
    arl: '',
  },
  auto: {
    // Milliseconds the generated show runs ahead of the reported track
    // position. Lives here rather than in run-time state because the right
    // value is a property of the room and the rig — player buffering, a polled
    // position API, Art-Net over the network, fixture latency, the throw from
    // the PA — and so it holds from one night to the next.
    syncOffsetMs: 0,
  },
  analysis: {
    analyzerTimeoutMs: 600000,
    downloadTimeoutMs: 300000,
    localRoot: '',
    // Blank auto-detects, preferring an interpreter that can actually import
    // the analyzer's dependencies. Set it when you have several Pythons and
    // pip installed into a different one than the launcher resolves to.
    pythonPath: '',
  },
};

// Never leaves the server in plaintext. The UI gets a "configured" flag instead
// and can set or clear the value, but never read it back.
const SECRET_PATHS = [
  'server.token', 'spotify.clientSecret', 'spotify.refreshToken', 'deezer.arl',
  // Bridge-issued, and together they are full control of the Hue system.
  'hue.username', 'hue.clientKey',
];

// Read once at boot, before anything is listening. Changing these persists
// immediately but only takes effect on the next start.
const RESTART_PATHS = ['server.host', 'server.port', 'server.token'];

// Hostname per RFC 1123, an IPv4 literal, or the two "all interfaces" forms.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const netHost = z.string().min(1).max(253).refine(
  (v) => v === '::' || v === '::1' || HOSTNAME_RE.test(v),
  { message: 'must be an IP address or hostname' },
);

const schema = z.object({
  server: z.object({
    host: netHost,
    port: z.number().int().min(1).max(65535),
    token: z.string().max(512),
    // Empty means "derive from host:port at startup".
    publicUrl: z.string().max(2048).refine(
      (v) => v === '' || /^https?:\/\/[^\s]+$/.test(v),
      { message: 'must be an http(s) URL' },
    ),
  }).strict(),
  artnet: z.object({
    enabled: z.boolean(),
    host: netHost,
    port: z.number().int().min(1).max(65535),
    universe: z.number().int().min(0).max(32767),
  }).strict(),
  sacn: z.object({
    enabled: z.boolean(),
    host: z.string().max(253).refine(
      (v) => v === '' || HOSTNAME_RE.test(v),
      { message: 'must be blank (multicast) or an IP address or hostname' },
    ),
    // E1.31 §6.2.3: 0-200, with 100 the default and higher winning when two
    // sources drive the same universe.
    priority: z.number().int().min(0).max(200),
    sourceName: z.string().min(1).max(63),
    // Enough range to map any Art-Net universe onto a legal sACN one.
    universeOffset: z.number().int().min(-32767).max(63999),
    cid: z.string().max(64).refine(
      (v) => v === '' || /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(v),
      { message: 'must be blank or a UUID' },
    ),
  }).strict(),
  hue: z.object({
    enabled: z.boolean(),
    host: z.string().max(253).refine(
      (v) => v === '' || HOSTNAME_RE.test(v),
      { message: 'must be blank or the bridge IP address or hostname' },
    ),
    username: z.string().max(128),
    applicationId: z.string().max(128),
    // 32 hex characters as issued, but accept any even-length hex run so a
    // future bridge with a longer key is a firmware note rather than a bug.
    clientKey: z.string().max(128).refine(
      (v) => v === '' || /^(?:[0-9a-fA-F]{2})+$/.test(v),
      { message: 'must be blank or the hex client key issued by the bridge' },
    ),
    entertainmentId: z.string().max(64).refine(
      (v) => v === '' || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
      { message: 'must be blank or an entertainment area id' },
    ),
    // Hue channel ids are a byte. Twenty is the protocol's own limit — one
    // stream message carries at most 20 channel slots, and an entertainment
    // area cannot hold more lights than that — so a longer list could never be
    // sent in full and is refused rather than silently truncated.
    channels: z.array(z.object({
      channel: z.number().int().min(0).max(255),
      fixture: z.number().int().min(0),
    }).strict()).max(20),
  }).strict(),
  midi: z.object({
    input: z.string().max(256),
    output: z.string().max(256),
    controlFeedback: z.boolean(),
  }).strict(),
  sources: z.object({
    prolink: z.boolean(),
    smtc: z.boolean(),
  }).strict(),
  spotify: z.object({
    clientId: z.string().max(256),
    clientSecret: z.string().max(256),
    refreshToken: z.string().max(2048),
    proxyBase: z.string().max(2048).refine(
      (v) => v === '' || /^https?:\/\/[^\s]+$/.test(v),
      { message: 'must be blank or an http(s) URL' },
    ),
    allowUnverifiedState: z.boolean(),
  }).strict(),
  deezer: z.object({
    arl: z.string().max(512),
  }).strict(),
  auto: z.object({
    syncOffsetMs: z.number().int().min(-SYNC_OFFSET_LIMIT_MS).max(SYNC_OFFSET_LIMIT_MS),
  }).strict(),
  analysis: z.object({
    // One minute floor: below that a normal track analysis would be killed
    // mid-run and never complete.
    analyzerTimeoutMs: z.number().int().min(60000).max(3600000),
    downloadTimeoutMs: z.number().int().min(10000).max(3600000),
    localRoot: z.string().max(4096),
    pythonPath: z.string().max(4096),
  }).strict(),
}).strict();

/** The shape accepted by PUT /api/settings: any subset, same rules. */
const patchSchema = z.object(
  Object.fromEntries(
    Object.entries(schema.shape).map(([group, groupSchema]) => [group, groupSchema.partial().strict().optional()]),
  ),
).strict();

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
function isLoopback(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Did a setting actually change?
 *
 * Identity is enough for the scalars that make up almost all of this tree, but
 * hue.channels is a list: validation rebuilds it on every save, so `!==` would
 * call it changed every time the page was saved and re-apply the Hue config for
 * nothing. These values are plain JSON by construction, so comparing their
 * serialisations is both correct and cheap at the once-per-save rate this runs
 * at.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Two-level merge — the settings tree is deliberately only groups and keys. */
function merge(base, patch) {
  const out = clone(base);
  for (const [group, values] of Object.entries(patch || {})) {
    if (!values || typeof values !== 'object') continue;
    out[group] = { ...out[group], ...values };
  }
  return out;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this._values = clone(DEFAULTS);
    this._listeners = [];
  }

  /**
   * Read settings.json. A missing file is normal (first run). A corrupt or
   * schema-invalid one is moved aside rather than deleted, so a hand-edit that
   * went wrong is recoverable, and the show still starts on defaults.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[settings] cannot read ${this.file}: ${err.message} — using defaults`);
      }
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this._quarantine(`invalid JSON (${err.message})`);
    }

    // Merge onto defaults first so a file written by an older build, missing
    // keys added since, still loads instead of failing validation wholesale.
    const result = schema.safeParse(merge(DEFAULTS, parsed));
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      return this._quarantine(detail);
    }

    this._values = result.data;
    return this;
  }

  _quarantine(reason) {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[settings] ${this.file}: ${reason}`);
      console.warn(`[settings] moved it to ${backup} and started on defaults`);
    } catch (err) {
      console.warn(`[settings] ${this.file}: ${reason} (could not move aside: ${err.message})`);
    }
    this._values = clone(DEFAULTS);
    return this;
  }

  /** Full effective settings, secrets included. Server-side callers only. */
  all() { return clone(this._values); }

  /** One group, e.g. settings.group('artnet'). */
  group(name) { return clone(this._values[name]); }

  get(dotted) { return getPath(this._values, dotted); }

  /**
   * The client-facing view: secrets replaced by a boolean saying whether one is
   * set. The UI can set or clear a secret but can never read it back, so a
   * shoulder-surfer or a stray screenshot doesn't leak the Deezer cookie.
   */
  redacted() {
    const out = this.all();
    const secrets = {};
    for (const dotted of SECRET_PATHS) {
      const [group, key] = dotted.split('.');
      secrets[dotted] = !!out[group][key];
      out[group][key] = '';
    }
    return { settings: out, secrets };
  }

  /**
   * Apply a partial update. Returns the keys that changed.
   *
   * Secret semantics: omit a secret to leave it alone, send '' to clear it.
   * Sending the redacted empty string back unchanged would otherwise wipe the
   * value every time the page saved, so the UI only includes a secret when the
   * operator actually typed one (or explicitly cleared it).
   */
  update(patch) {
    const parsedPatch = patchSchema.parse(patch || {});
    const next = schema.parse(merge(this._values, parsedPatch));

    // Refuse to save the one combination that bricks the settings page: a
    // non-loopback bind with no token makes the server refuse to start, and
    // then there is no UI left to undo it from. The startup guard still exists
    // as a backstop for a hand-edited file; this stops the UI walking into it.
    if (!isLoopback(next.server.host) && !next.server.token) {
      const err = new Error(
        'Set an access token before binding to ' + next.server.host + '. '
        + 'Without one, anyone on the network could black out the rig, so the '
        + 'server refuses to start — and you would have to edit settings.json '
        + 'by hand to recover. Use Generate next to Access Token.',
      );
      err.status = 400;
      throw err;
    }

    const changed = [];
    for (const [group, values] of Object.entries(next)) {
      for (const [key, value] of Object.entries(values)) {
        if (!sameValue(this._values[group][key], value)) changed.push(`${group}.${key}`);
      }
    }
    if (!changed.length) return changed;

    const previous = this._values;
    this._values = next;
    try {
      this.save();
    } catch (err) {
      this._values = previous;          // don't diverge from what's on disk
      throw err;
    }
    for (const fn of this._listeners) {
      try { fn(changed, this.all()); } catch (e) { console.warn(`[settings] listener: ${e.message}`); }
    }
    return changed;
  }

  /** Write atomically and 0600 — this file holds secrets. */
  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this._values, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch (_) { /* best effort on Windows */ }
  }

  /** Called with (changedKeys, settings) after every successful update. */
  onChange(fn) { this._listeners.push(fn); }

  /**
   * Which restart-only settings differ from what this process actually booted
   * with. The page uses it to show "restart to apply" against the right rows
   * instead of nagging about every save.
   */
  pendingRestart(bootValues) {
    return RESTART_PATHS.filter((dotted) => getPath(bootValues, dotted) !== this.get(dotted));
  }
}

// Env vars that used to configure the server. Read only to tell the operator
// they no longer do anything — settings live in the page now.
const LEGACY_ENV = [
  'HOST', 'PORT', 'LIGHTSHOW_TOKEN', 'PUBLIC_URL',
  'ARTNET_HOST', 'ARTNET_PORT', 'ARTNET_UNIVERSE',
  'MIDI_INPUT', 'MIDI_OUTPUT',
  'PROLINK', 'SMTC',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_PROXY_BASE',
  'SPOTIFY_ALLOW_UNVERIFIED_STATE',
  'DEEZER_ARL',
  'ANALYZER_TIMEOUT_MS', 'DOWNLOAD_TIMEOUT_MS', 'ANALYZE_LOCAL_ROOT',
];

/**
 * A .env left over from before settings moved into the UI would otherwise go
 * quiet: the rig would come up on defaults with no clue why. Name the variables
 * that are now ignored and where to put them instead.
 */
function warnAboutLegacyEnv(env = process.env, log = console.warn) {
  const present = LEGACY_ENV.filter((name) => env[name] !== undefined && env[name] !== '');
  if (!present.length) return present;
  log(`\n[settings] These environment variables are no longer read: ${present.join(', ')}`);
  log('[settings] Settings now live in the settings page (⚙ → Settings) and are stored');
  log(`[settings] in config/settings.json. Set them there; you can delete them from .env.\n`);
  return present;
}

// The store every module reads from. Instantiated here rather than passed
// around because the settings it holds are consulted at call time from deep
// inside the analyzer and download paths, exactly as `state` is.
//
// The file location is fixed on purpose: it is how you *find* the settings, not
// itself a setting, and leaving it env-configurable would reintroduce the split
// brain this change removes. Tests construct their own SettingsStore instead.
const CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'settings.json');
//
// Loaded on construction so require order cannot matter: state.js reads
// settings.group('artnet') at module scope, and it must see the stored values
// rather than bare defaults regardless of who requires whom first.
const settings = new SettingsStore(CONFIG_FILE).load();

module.exports = {
  settings,
  CONFIG_FILE,
  SettingsStore,
  DEFAULTS,
  SECRET_PATHS,
  RESTART_PATHS,
  LEGACY_ENV,
  schema,
  patchSchema,
  warnAboutLegacyEnv,
};
