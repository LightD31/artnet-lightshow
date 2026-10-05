import net from 'node:net';
import { z } from 'zod';
import { SYNC_OFFSET_LIMIT_MS, TEMPO_MODES } from './presets.ts';
import { HttpError, messageOf } from '../errors.ts';
import { configFile } from './config-dir.ts';
import { isLoopback } from './loopback.ts';
import { JsonStore } from './json-store.ts';
import { HUE_BRIDGE_ID_RE } from '../shared/placement.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import { STROBE_DEFAULTS, STROBE_PARAMS_SCHEMA } from '../shared/effects/strobe.ts';
import { hexColour } from './validation.ts';

/**
 * Persisted configuration, edited in the app's Rig, Sources and Settings views.
 *
 * Everything the operator can configure lives here and is edited in the UI, not
 * in the environment. `process.env` is deliberately NOT consulted: a value is
 * either stored in settings.json or it is the default below. That means one
 * place to look when a setting isn't doing what you expect, and an app that
 * always shows the truth rather than whatever a shell happened to export.
 *
 * (Legacy env vars are detected at startup only to warn that they are ignored —
 * see warnAboutLegacyEnv(). Nothing reads them for their value.)
 *
 * The file holds secrets (Spotify client secret, Deezer ARL, the access token),
 * so it is written 0600 and must stay out of version control.
 */

/** Every setting, as validated by `schema` below. */
export type Settings = z.infer<typeof schema>;

/** Any subset of the settings, group by group: what PUT /api/settings takes. */
export type SettingsPatch = { [G in keyof Settings]?: Partial<Settings[G]> };

/** A setting's dotted path: 'server.host', 'artnet.universe'… */
export type SettingPath = { [G in keyof Settings]: `${G}.${keyof Settings[G] & string}` }[keyof Settings];

/** The value at a dotted path. */
export type SettingAt<P extends string> = P extends `${infer G}.${infer K}`
  ? G extends keyof Settings ? K extends keyof Settings[G] ? Settings[G][K] : never : never
  : never;

/** Called after an update with the dotted keys that changed and the new settings. */
export type SettingsListener = (changed: string[], settings: Settings) => void;

const DEFAULTS: Settings = {
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
    // While the target is a broadcast address, find the nodes on the network
    // and send each the universes it outputs directly (see artnet-nodes.js).
    discovery: true,
    // ArtSync after every frame, so the nodes change all their universes at
    // once. Off by default: a node that has seen one waits for the next.
    sync: false,
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
    // The local address multicast leaves from. Blank lets the OS choose; name
    // the show network's address on a machine that is also on another one.
    interface: '',
  },
  // Philips Hue Entertainment. Nothing by default: a bridge needs credentials
  // it issues itself, so one only exists here once it has been paired. Unlike
  // Art-Net and sACN this does not carry a universe: each lamp of a bridge's
  // area is a fixture in the patch, and its channel is sent the colour it is
  // rendered. Several bridges stream at once, each its own area.
  hue: {
    // One entry per paired bridge (see hueBridge below): its id, which the
    // fixtures name; a label; whether its output is on; its address; the
    // application key and client key the bridge issued (secrets, write-only
    // from the UI's point of view); the application id the DTLS handshake
    // identifies as; and the entertainment area it streams.
    bridges: [],
    // How far the Art-Net and sACN output is held back so the pars land with
    // the Hue lamps. The bridge and its Zigbee relay add a delay the DMX wire
    // does not have, so on a mixed rig every hit reaches the pars first. Tuned
    // by eye against the sync test; 0 sends everything the moment it renders.
    // One delay for every bridge: they all sit behind the same kind of hop.
    latencyMs: 0,
    // How a Hue lamp takes a flash: 'flash' hard on and off as far as the
    // bridge follows, 'pulse' at full falling to a floor over 200 ms, as the
    // party apps fade a hit lamp back.
    strobe: 'flash',
  },
  midi: {
    input: '',
    output: '',
    // Drive motorised faders and encoder LED rings back to the show's state.
    // Harmless on a controller without them — it ignores the CC — but a MIDI
    // loopback would echo our feedback in as operator input, so it is a switch.
    controlFeedback: true,
    // Send the pattern clock as MIDI clock to this port — a drum machine, a
    // DAW, visuals through a loopback port. Blank sends none.
    clockOutput: '',
  },
  sources: {
    prolink: false,
    smtc: true,
  },
  live: {
    // Hear the music as it plays (src/live-input.ts): for the beat of a track
    // no source knows, and to line a known track's show up with the room.
    enabled: false,
    // 'loopback' hears what this computer plays; 'input' a line-in or mic.
    source: 'loopback',
    // Blank for the system default; otherwise a device name, or part of one.
    device: '',
    // How much later the room hears the audio than it is captured: positive
    // for loopback ahead of a PA, negative for a line-in off the booth.
    latencyMs: 0,
    // Line a known track's show up with what the live input hears, rather
    // than trust the playback source's position (see auto-sync.ts).
    autoSync: true,
    // With the auto show on and no analysed track to play — the next one still
    // being analysed, or music nothing can name — answer what is heard.
    director: true,
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
    // Remember the night: each track avoids the last one's palette and looks,
    // keeps some of its colours when the keys mix, and paces its big moments
    // against the tracks before it (src/show/set-memory.ts). Off plans every
    // track on its own, as if it were the first of the night.
    setMemory: true,
  },
  clock: {
    // Automatic tempo match: 'auto' follows the music (the auto show, a deck,
    // the track, the live input); 'manual' keeps the tempo the operator taps
    // or types, bar the running auto show's grid (conductor.ts). Kept so the
    // choice survives a restart.
    tempoMode: 'auto',
  },
  // How the party effects take the music (audio-features.ts). 'off' runs
  // them on their loops, 'tempo' on the beat alone, 'reactive' lets what the
  // live input hears drive them. Hue Dynamics' master shapes its Party levels
  // and gates; Light DJ's trigger places its loud and soft beats while no
  // playing Visualizer sets its own.
  audio: {
    mode: 'tempo',
    master: { ...HD_MASTER_DEFAULTS },
    ldjTrigger: 0.3,
  },
  safety: {
    // Hold the rig to three large-area flashes a second, the photosensitivity
    // threshold broadcast and web guidance share (src/server/flash-limit.ts).
    // Off by default: most of what a party rig is for is above it.
    flashLimit: false,
    // Hue Dynamics' limit on each lamp's bright rises inside its own effects:
    // a second one within this many ms stays dark. 0 turns it off.
    hdFlashIntervalMs: 350,
    // The strobe and every effect that flashes faster than the photosensitivity
    // threshold render nothing until the operator says the room may see them.
    photosensitivityAcknowledged: false,
    // A latched strobe is cut after this long, whoever latched it.
    strobeMaxLatchSec: 60,
  },
  // The manual strobe: two flashes a second on the beat clock (Hue Dynamics
  // keeps the wall clock), the look between them, 100 ms on and 100 ms black
  // as Hue Dynamics flashes, in white. A cue keeps these, never whether it is on.
  strobe: {
    ...STROBE_DEFAULTS,
    palette: ['#FFFFFF'],
  },
  // Whether anything leaves the machine (armed.ts). Stored so the Show
  // section and the REST routes share one switch; never honoured at start —
  // the applier puts it back to off, so a reboot cannot start a show in the
  // room (apply.ts).
  outputs: {
    armed: false,
  },
  // The first-run setup (the page's onboarding wizard): offered until it has
  // been finished or skipped once. A settings file from before the wizard
  // belongs to a rig that is set up already (see load()).
  setup: {
    completed: false,
  },
  engine: {
    // Where frames are rendered. 'worker' gives the engine a thread of its
    // own, so the rig keeps its timing while the main thread plans a track,
    // parses an upload or serves the UI; 'main' renders on the main thread as
    // it always used to, and is there for diagnosing a problem.
    thread: 'worker',
  },
  analysis: {
    analyzerTimeoutMs: 600000,
    downloadTimeoutMs: 300000,
    localRoot: '',
    // Blank auto-detects, preferring an interpreter that can actually import
    // the analyzer's dependencies. Set it when you have several Pythons and
    // pip installed into a different one than the launcher resolves to.
    pythonPath: '',
    // Which model splits a track into drums, bass, vocals and other.
    // BS-RoFormer is the more careful of the two and takes about seven times
    // as long: on a Radeon 890M it needs ~400 s for a 3.5-minute track, which
    // is slower than the track plays, where Demucs needs ~60 s. The default is
    // the one that keeps up with a live set.
    separator: 'demucs',
    // Where a track's sections come from. 'auto' asks SongFormer when the
    // analyser has a GPU and its weights are downloaded, and the self-similarity
    // labeller otherwise: on a CPU SongFormer takes most of the track's length.
    // 'songformer' asks it on a CPU too; 'off' never.
    structureModel: 'auto',
    // Where the analysis models' weights live between passes on a CUDA card.
    // 'auto' keeps them in RAM on a card under 12 GB, which cannot hold them
    // all at once, and brings each onto the card for its own pass; 'offload'
    // always does, 'resident' never (see src/analysis/models.py).
    gpuMemory: 'auto',
  },
};

// Never leaves the server in plaintext. The UI gets a "configured" flag instead
// and can set or clear the value, but never read it back.
const SECRET_PATHS = [
  'server.token', 'spotify.clientSecret', 'spotify.refreshToken', 'deezer.arl',
];

// The secrets inside each entry of hue.bridges: bridge-issued, and together
// they are full control of that Hue system. Blanked on the way out like the
// paths above; a blank one sent back keeps the stored value (see update()).
const HUE_SECRET_KEYS = ['username', 'clientKey'] as const;

// The id the one bridge of a settings file written before several were
// possible gets, so the lamps already in the patch (which name no bridge)
// find it. The ids after it are bridge-2, bridge-3… (routes/outputs.ts).
const LEGACY_HUE_BRIDGE_ID = 'bridge-1';

// The scalar form hue took before hue.bridges: one bridge, its fields at the
// top of the group. Migrated on load; refused on PUT, with a pointer.
const LEGACY_HUE_KEYS = ['enabled', 'host', 'username', 'clientKey', 'applicationId', 'entertainmentId'] as const;

// Hue Dynamics' music modes, as `audio.mode` takes them.
const AUDIO_MODES = ['off', 'tempo', 'reactive'] as const;
const fraction = z.number().min(0).max(1);
// Hue Dynamics' own limits: two seconds of attack, five of release.
const attackMs = z.number().int().min(0).max(2000);
const releaseMs = z.number().int().min(0).max(5000);


// Read once at boot, before anything is listening. Changing these persists
// immediately but only takes effect on the next start.
const RESTART_PATHS = ['server.host', 'server.port', 'server.token', 'engine.thread'];

// Hostname per RFC 1123, an IPv4 literal, or the two "all interfaces" forms.
// python, python3, python3.12, python3.12t, pythonw, py — with .exe on Windows.
const PYTHON_BASENAME_RE = /^(python(\d+(\.\d+)*t?)?w?|py)(\.exe)?$/i;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const netHost = z.string().min(1).max(253).refine(
  (v) => v === '::' || v === '::1' || HOSTNAME_RE.test(v),
  { message: 'must be an IP address or hostname' },
);

/** One paired Hue bridge, as hue.bridges holds it. */
const hueBridge = z.object({
  id: z.string().regex(HUE_BRIDGE_ID_RE, 'must be a short plain id'),
  label: z.string().max(64),
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
}).strict();

/** A bridge entry: what the Hue output, the routes and the pre-show check read. */
export type HueBridgeSettings = z.infer<typeof hueBridge>;

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
    discovery: z.boolean(),
    sync: z.boolean(),
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
    interface: z.string().max(15).refine(
      (v) => v === '' || net.isIPv4(v),
      { message: 'must be blank or an IPv4 address of this machine' },
    ),
  }).strict(),
  hue: z.object({
    bridges: z.array(hueBridge).max(16).refine(
      (list) => new Set(list.map((b) => b.id)).size === list.length,
      { message: 'two bridges have the same id' },
    ),
    // Half a second is far past any bridge; anything that long is a setting
    // typed in the wrong unit.
    latencyMs: z.number().int().min(0).max(500),
    strobe: z.enum(['flash', 'pulse']),
  }).strict(),
  midi: z.object({
    input: z.string().max(256),
    output: z.string().max(256),
    controlFeedback: z.boolean(),
    clockOutput: z.string().max(256),
  }).strict(),
  sources: z.object({
    prolink: z.boolean(),
    smtc: z.boolean(),
  }).strict(),
  live: z.object({
    enabled: z.boolean(),
    source: z.enum(['loopback', 'input']),
    device: z.string().max(256),
    latencyMs: z.number().int().min(-500).max(500),
    autoSync: z.boolean(),
    director: z.boolean(),
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
    setMemory: z.boolean(),
  }).strict(),
  clock: z.object({
    tempoMode: z.enum(TEMPO_MODES),
  }).strict(),
  audio: z.object({
    mode: z.enum(AUDIO_MODES),
    master: z.object({
      sensitivity: fraction, smoothing: fraction, attackMs, releaseMs,
      threshold: fraction, reactiveDepth: fraction, brightness: fraction,
    }).strict(),
    ldjTrigger: fraction,
  }).strict(),
  safety: z.object({
    flashLimit: z.boolean(),
    // No upper bounds of their own: the apps state none.
    hdFlashIntervalMs: z.number().finite().min(0),
    photosensitivityAcknowledged: z.boolean(),
    strobeMaxLatchSec: z.number().finite().positive(),
  }).strict(),
  // The kind's own parameters, and its colours beside them: a palette of the
  // strobe's, which the voice plays as its effect's palette.
  strobe: STROBE_PARAMS_SCHEMA.extend({
    palette: z.array(hexColour).min(1).max(6),
  }).strict(),
  outputs: z.object({
    armed: z.boolean(),
  }).strict(),
  setup: z.object({
    completed: z.boolean(),
  }).strict(),
  engine: z.object({
    thread: z.enum(['worker', 'main']),
  }).strict(),
  analysis: z.object({
    // One minute floor: below that a normal track analysis would be killed
    // mid-run and never complete.
    analyzerTimeoutMs: z.number().int().min(60000).max(3600000),
    downloadTimeoutMs: z.number().int().min(10000).max(3600000),
    localRoot: z.string().max(4096),
    // Whatever is named here is executed, so it has to at least be named like
    // a Python interpreter (python, python3, python3.12, pythonw.exe, py.exe…).
    // That keeps the setting from being a way to run an arbitrary program.
    pythonPath: z.string().max(4096).refine(
      (value) => value === '' || PYTHON_BASENAME_RE.test(value.trim().split(/[\\/]/).pop() ?? ''),
      'must be the path to a Python interpreter (python, python3, pythonw, py)',
    ),
    separator: z.enum(['demucs', 'bs-roformer']),
    structureModel: z.enum(['auto', 'songformer', 'off']),
    gpuMemory: z.enum(['auto', 'offload', 'resident']),
  }).strict(),
}).strict();

/** The shape accepted by PUT /api/settings: any subset, same rules. */
const patchSchema = z.object(
  Object.fromEntries(
    Object.entries(schema.shape).map(([group, groupSchema]) => [group, groupSchema.partial().strict().optional()]),
  ),
).strict();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), obj);
}

/**
 * Did a setting actually change?
 *
 * Identity is enough for the scalars that make up this tree. A list or an
 * object, should one be added, is rebuilt by validation on every save, so `!==`
 * would call it changed every time the page was saved. These values are plain
 * JSON by construction, so comparing their serialisations is both correct and
 * cheap at the once-per-save rate this runs at.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Two-level merge — the settings tree is deliberately only groups and keys. */
function merge(base: Settings, patch: unknown): Settings {
  const out = clone(base) as Record<string, object>;
  for (const [group, values] of Object.entries(patch || {})) {
    if (!values || typeof values !== 'object') continue;
    out[group] = { ...out[group], ...values };
  }
  return out as Settings;
}

/**
 * Clear stored values that an older build accepted and this one refuses.
 * Mutates `parsed`; returns the dotted paths it cleared.
 */
function clearNewlyInvalidFields(parsed: unknown): string[] {
  const cleared: string[] = [];
  const analysis = parsed && typeof parsed === 'object'
    ? (parsed as { analysis?: { pythonPath?: unknown } }).analysis : null;
  if (analysis && typeof analysis.pythonPath === 'string') {
    const check = schema.shape.analysis.shape.pythonPath.safeParse(analysis.pythonPath);
    if (!check.success) {
      console.warn(`[settings] analysis.pythonPath "${analysis.pythonPath}" is not a Python interpreter `
        + '— cleared; the analyser will look for one on PATH. Set it again in Settings → Analysis.');
      analysis.pythonPath = '';
      cleared.push('analysis.pythonPath');
    }
  }
  return cleared;
}

/** Whether a hue group is in the one-bridge form from before hue.bridges. */
function isLegacyHue(hue: unknown): hue is Record<string, unknown> {
  return !!hue && typeof hue === 'object' && !Array.isArray(hue)
    && !('bridges' in hue) && LEGACY_HUE_KEYS.some((key) => key in hue);
}

/**
 * The one bridge a file from before several were possible describes, moved
 * into hue.bridges as bridge-1. Mutates `parsed`; returns whether it did.
 *
 * A file whose bridge was never paired (every field blank) migrates to no
 * bridge at all: an empty entry would only be a row to forget. `hue.channels`,
 * the binding map of an older build still, goes with the scalar fields.
 */
function migrateLegacyHue(parsed: unknown): boolean {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const hue = root ? root.hue : null;
  if (!root || !isLegacyHue(hue)) return false;
  const text = (key: string) => (typeof hue[key] === 'string' ? hue[key] as string : '');
  const bridge: HueBridgeSettings = {
    id: LEGACY_HUE_BRIDGE_ID,
    label: text('host') || 'Hue bridge',
    enabled: hue.enabled === true,
    host: text('host'),
    username: text('username'),
    clientKey: text('clientKey'),
    applicationId: text('applicationId'),
    entertainmentId: text('entertainmentId'),
  };
  const paired = !!(bridge.host || bridge.username || bridge.clientKey);
  for (const key of [...LEGACY_HUE_KEYS, 'channels']) delete hue[key];
  hue.bridges = paired ? [bridge] : [];
  if (paired) {
    console.warn(`[settings] the Hue bridge at ${bridge.host || '(no address)'} is now hue.bridges[0] as "${LEGACY_HUE_BRIDGE_ID}"`);
  }
  return true;
}

/** The bridge a Hue lamp that names none belongs to: the first, or the id the migration gives. */
function defaultHueBridgeId(bridges: readonly { id: string }[]): string {
  return bridges.length ? bridges[0].id : LEGACY_HUE_BRIDGE_ID;
}

class SettingsStore extends JsonStore {
  declare _values: Settings;
  declare _listeners: SettingsListener[];

  /**
   * settings.json, written 0600: it holds secrets. No file is normal (first
   * run); a corrupt or schema-invalid one is moved aside (JsonStore), so a
   * hand-edit that went wrong is recoverable, and the show still starts on
   * defaults.
   */
  constructor(file: string) {
    super(file, { tag: 'settings', fallback: 'using the defaults', mode: 0o600 });
    this._values = clone(DEFAULTS);
    this._listeners = [];
  }

  load(): this {
    const saved = this.readValid(schema, (parsed) => {
      // Written before the setup wizard existed: this rig was set up without
      // it, and offering it now would walk the operator through a rig they
      // already built.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('setup' in parsed)) {
        (parsed as Record<string, unknown>).setup = { completed: true };
      }
      // A rule added after the file was written must not throw away the whole
      // file — Spotify credentials, the token, the Hue pairing — for the sake
      // of one field. Such fields are cleared here, loudly, and the rest loads.
      clearNewlyInvalidFields(parsed);
      // One Hue bridge, written as scalars, becomes the first of hue.bridges.
      migrateLegacyHue(parsed);
      // Merged onto the defaults first, so a file written by an older build,
      // missing keys added since, still loads instead of failing validation
      // wholesale.
      return merge(DEFAULTS, parsed);
    });
    if (saved) this._values = saved;
    return this;
  }

  useDefaults(): void {
    this._values = clone(DEFAULTS);
  }

  /** Full effective settings, secrets included. Server-side callers only. */
  all(): Settings { return clone(this._values); }

  /** One group, e.g. settings.group('artnet'). */
  group<G extends keyof Settings>(name: G): Settings[G] { return clone(this._values[name]); }

  get<P extends SettingPath>(dotted: P): SettingAt<P>;
  get(dotted: string): unknown;
  get(dotted: string): unknown { return getPath(this._values, dotted); }

  /**
   * The client-facing view: secrets replaced by a boolean saying whether one is
   * set. The UI can set or clear a secret but can never read it back, so a
   * shoulder-surfer or a stray screenshot doesn't leak the Deezer cookie.
   */
  redacted(): { settings: Settings; secrets: Record<string, boolean> } {
    const out = this.all();
    const groups = out as unknown as Record<string, Record<string, unknown>>;
    const secrets: Record<string, boolean> = {};
    for (const dotted of SECRET_PATHS) {
      const [group, key] = dotted.split('.');
      secrets[dotted] = !!groups[group][key];
      groups[group][key] = '';
    }
    // A bridge's keys are blanked the same way; whether it is paired is what
    // GET /api/hue/status says, so there is no entry for them here.
    for (const bridge of out.hue.bridges) {
      for (const key of HUE_SECRET_KEYS) bridge[key] = '';
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
  update(patch: unknown): string[] {
    const hue = patch && typeof patch === 'object' ? (patch as { hue?: unknown }).hue : null;
    if (isLegacyHue(hue)) {
      const named = LEGACY_HUE_KEYS.filter((key) => key in hue).map((key) => `hue.${key}`).join(', ');
      throw new HttpError(400,
        `${named}: a Hue bridge is an entry of hue.bridges now. Pair one with POST /api/hue/pair, `
        + 'pick its area and turn it on through hue.bridges, and forget it with POST /api/hue/:bridge/disconnect.');
    }
    const parsedPatch = patchSchema.parse(patch || {});
    // The keys a bridge was issued are never sent to a client, so a list sent
    // back carries them blank: blank keeps what is stored, as an omitted
    // secret does. Forgetting a bridge is removing its entry, never blanking.
    const hueDraft = (parsedPatch as { hue?: Partial<Settings['hue']> }).hue;
    if (hueDraft?.bridges) {
      const stored = new Map(this._values.hue.bridges.map((b) => [b.id, b]));
      for (const bridge of hueDraft.bridges) {
        const was = stored.get(bridge.id);
        if (!was) continue;
        for (const key of HUE_SECRET_KEYS) if (!bridge[key]) bridge[key] = was[key];
      }
    }
    const next = schema.parse(merge(this._values, parsedPatch));

    // Refuse to save the one combination that locks the app out: a
    // non-loopback bind with no token makes the server refuse to start, and
    // then there is no UI left to undo it from. The startup guard still exists
    // as a backstop for a hand-edited file; this stops the UI walking into it.
    if (!isLoopback(next.server.host) && !next.server.token) {
      throw new HttpError(400,
        'Set an access token before binding to ' + next.server.host + '. '
        + 'Without one, anyone on the network could black out the rig, so the '
        + 'server refuses to start — and you would have to edit settings.json '
        + 'by hand to recover. Use Generate next to Access Token.',
      );
    }

    const current = this._values as unknown as Record<string, Record<string, unknown>>;
    const changed: string[] = [];
    for (const [group, values] of Object.entries(next)) {
      for (const [key, value] of Object.entries(values)) {
        if (!sameValue(current[group][key], value)) changed.push(`${group}.${key}`);
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
      try { fn(changed, this.all()); } catch (e) { console.warn(`[settings] listener: ${messageOf(e)}`); }
    }
    return changed;
  }

  /** Write atomically and 0600 — this file holds secrets. */
  save(): void {
    this.writeJson(this._values);
  }

  /** Called with (changedKeys, settings) after every successful update. */
  onChange(fn: SettingsListener): void { this._listeners.push(fn); }

  /**
   * Which restart-only settings differ from what this process actually booted
   * with. The page uses it to show "restart to apply" against the right rows
   * instead of nagging about every save.
   */
  pendingRestart(bootValues: unknown): string[] {
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
function warnAboutLegacyEnv(env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn): string[] {
  const present = LEGACY_ENV.filter((name) => env[name] !== undefined && env[name] !== '');
  if (!present.length) return present;
  log(`\n[settings] These environment variables are no longer read: ${present.join(', ')}`);
  log('[settings] Settings now live in the app (its Rig, Sources and Settings views) and are stored');
  log(`[settings] in ${configFile('settings.json')}. Set them there; you can delete them from .env.\n`);
  return present;
}

// The store every module reads from. Instantiated here rather than passed
// around because the settings it holds are consulted at call time from deep
// inside the analyzer and download paths, exactly as `state` is.
//
// The file location is fixed on purpose: it is how you *find* the settings, not
// itself a setting, and leaving it env-configurable would reintroduce the split
// brain this change removes. Tests construct their own SettingsStore instead.
const CONFIG_FILE = configFile('settings.json');
//
// Loaded on construction so require order cannot matter: state.js reads
// settings.group('artnet') at module scope, and it must see the stored values
// rather than bare defaults regardless of who requires whom first.
const settings = new SettingsStore(CONFIG_FILE).load();

export {
  settings,
  CONFIG_FILE,
  SettingsStore,
  DEFAULTS,
  SECRET_PATHS,
  HUE_SECRET_KEYS,
  LEGACY_HUE_BRIDGE_ID,
  RESTART_PATHS,
  LEGACY_ENV,
  schema,
  hueBridge,
  patchSchema,
  defaultHueBridgeId,
  migrateLegacyHue,
  warnAboutLegacyEnv,
};
