import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SettingsStore, DEFAULTS, LEGACY_HUE_BRIDGE_ID, migrateLegacyHue, warnAboutLegacyEnv } from '../../src/server/settings.ts';
import { schema, patchSchema } from '../../src/server/settings.ts';

let counter = 0;
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lightshow-settings-${counter++}-`));
  return new SettingsStore(path.join(dir, 'settings.json'));
}

test('a missing file is the first run, not an error', () => {
  const s = store().load();
  assert.deepStrictEqual(s.group('artnet'), DEFAULTS.artnet);
});

test('updates persist and reload', () => {
  const s = store().load();
  const changed = s.update({ artnet: { host: '10.0.0.5' }, analysis: { downloadTimeoutMs: 90000 } });
  assert.deepStrictEqual(changed.sort(), ['analysis.downloadTimeoutMs', 'artnet.host']);

  const reloaded = new SettingsStore(s.file).load();
  assert.strictEqual(reloaded.get('artnet.host'), '10.0.0.5');
  assert.strictEqual(reloaded.get('analysis.downloadTimeoutMs'), 90000);
  assert.strictEqual(reloaded.get('artnet.port'), DEFAULTS.artnet.port, 'untouched keys keep defaults');
});

test('a no-op update reports no changes', () => {
  const s = store().load();
  assert.deepStrictEqual(s.update({ artnet: { host: DEFAULTS.artnet.host } }), []);
});

// Secrets exist to be used by the server, never displayed. A screenshot of the
// settings page must not leak the Deezer cookie.
test('secrets are never handed back to the client', () => {
  const s = store().load();
  s.update({
    deezer: { arl: 'cookie-value' },
    // The refresh token is a full Spotify session: anyone holding it can mint
    // access tokens for the connected account until it is revoked. It is
    // written by the server rather than typed, but it leaks exactly as badly.
    spotify: { clientSecret: 'shh', refreshToken: 'a-live-session' },
    // Bridge-issued rather than typed, and together they are the DTLS identity
    // and the pre-shared key — enough to drive the whole Hue system. One pair
    // per bridge, inside its entry.
    hue: { bridges: [{ ...BRIDGE, username: 'app-key', clientKey: 'abcdef01' }] },
  });

  const { settings, secrets } = s.redacted();
  assert.strictEqual(settings.deezer.arl, '', 'redacted out');
  assert.strictEqual(settings.spotify.clientSecret, '');
  assert.strictEqual(settings.spotify.refreshToken, '');
  assert.deepStrictEqual(settings.hue.bridges, [{ ...BRIDGE, username: '', clientKey: '' }], 'the bridge is there, its keys are not');
  assert.deepStrictEqual(secrets, {
    'server.token': false,
    'spotify.clientSecret': true,
    'spotify.refreshToken': true,
    'deezer.arl': true,
  });
  assert.ok(!JSON.stringify(s.redacted()).includes('abcdef01'), 'nowhere in what a client gets');
  assert.strictEqual(s.get('deezer.arl'), 'cookie-value', 'still readable server-side');
  assert.strictEqual(s.get('spotify.refreshToken'), 'a-live-session');
  assert.strictEqual(s.get('hue.bridges')[0].clientKey, 'abcdef01');
});

const BRIDGE = { id: 'bridge-1', label: 'Lounge', enabled: true, host: '10.0.0.9', username: '', clientKey: '', applicationId: '', entertainmentId: '' };

// The page gets the bridges with their keys blanked, and sends the list back
// to change an area or a label: blank has to mean "keep", or every such save
// would unpair the bridge.
test('a bridge sent back with blank keys keeps the stored ones; a bridge dropped from the list is forgotten', () => {
  const s = store().load();
  s.update({ hue: { bridges: [{ ...BRIDGE, username: 'app-key', clientKey: 'abcdef01' }] } });
  const changed = s.update({ hue: { bridges: [{ ...BRIDGE, enabled: false, username: '', clientKey: '' }] } });
  assert.deepStrictEqual(changed, ['hue.bridges']);
  assert.deepStrictEqual(s.get('hue.bridges'), [{ ...BRIDGE, enabled: false, username: 'app-key', clientKey: 'abcdef01' }]);
  s.update({ hue: { bridges: [] } });
  assert.deepStrictEqual(s.get('hue.bridges'), []);
  assert.throws(() => s.update({ hue: { bridges: [BRIDGE, { ...BRIDGE, label: 'Twin' }] } }), /same id/);
});

// The settings file of a rig set up when there could be only one bridge
// holds it as scalars under hue. It loads as the first of hue.bridges, keys
// and all, so nothing has to be paired again.
test('a settings file with one bridge in the old form loads it as bridge-1', () => {
  const s = store();
  fs.writeFileSync(s.file, JSON.stringify({
    hue: {
      enabled: true, host: '10.0.0.9', username: 'app-key', clientKey: 'abcdef01',
      applicationId: 'a966c4cc-018d-4422-aad8-414843fc4fad', entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
      latencyMs: 60, channels: { 0: 1 },
    },
  }));
  s.load();
  assert.deepStrictEqual(s.group('hue'), {
    bridges: [{
      id: 'bridge-1', label: '10.0.0.9', enabled: true, host: '10.0.0.9', username: 'app-key', clientKey: 'abcdef01',
      applicationId: 'a966c4cc-018d-4422-aad8-414843fc4fad', entertainmentId: '0123abcd-1234-5678-9abc-def012345678',
    }],
    latencyMs: 60,
    // Older than the setting: the default.
    strobe: 'flash',
  });
  s.update({ hue: { latencyMs: 70 } });
  const written = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.strictEqual(written.hue.host, undefined, 'the next save writes the new form');
  assert.strictEqual(written.hue.bridges[0].clientKey, 'abcdef01');
  assert.deepStrictEqual(new SettingsStore(s.file).load().group('hue').bridges.map((b) => b.id), ['bridge-1']);
});

test('an old-form file whose bridge was never paired loads with no bridge at all', () => {
  const s = store();
  fs.writeFileSync(s.file, JSON.stringify({ hue: { enabled: false, host: '', username: '', clientKey: '', applicationId: '', entertainmentId: '', latencyMs: 0 } }));
  assert.deepStrictEqual(s.load().group('hue'), { bridges: [], latencyMs: 0, strobe: 'flash' });
});

test('migrating the old form is a pure step on the parsed file', () => {
  const parsed = { hue: { enabled: true, host: '10.0.0.9', username: 'k', clientKey: 'aabb', latencyMs: 5 }, artnet: { port: 6454 } };
  assert.strictEqual(migrateLegacyHue(parsed), true);
  assert.deepStrictEqual(Object.keys(parsed.hue).sort(), ['bridges', 'latencyMs']);
  assert.strictEqual(parsed.hue.bridges[0].id, LEGACY_HUE_BRIDGE_ID);
  assert.strictEqual(migrateLegacyHue({ hue: { bridges: [], latencyMs: 0 } }), false, 'the new form is left alone');
  assert.strictEqual(migrateLegacyHue({ hue: { latencyMs: 0 } }), false);
  assert.strictEqual(migrateLegacyHue(null), false);
});

test('a save in the old form is refused with a pointer to hue.bridges', () => {
  const s = store().load();
  assert.throws(() => s.update({ hue: { host: '10.0.0.9', enabled: true } }), /hue\.enabled, hue\.host.*hue\.bridges.*\/api\/hue\/pair/);
  assert.deepStrictEqual(s.group('hue'), DEFAULTS.hue, 'nothing was saved');
});

// The settings page has no field for the refresh token, so its saves never
// mention it. If an omitted secret were treated as "clear it", every visit to
// the settings page would sign the operator out of Spotify.
test('saving the settings page leaves the stored Spotify session alone', () => {
  const s = store().load();
  s.update({ spotify: { clientId: 'id', clientSecret: 'shh', refreshToken: 'a-live-session' } });

  s.update({ spotify: { clientId: 'a-different-id' } });

  assert.strictEqual(s.get('spotify.refreshToken'), 'a-live-session', 'session survived');
  assert.strictEqual(s.get('spotify.clientSecret'), 'shh', 'so did the client secret');
});

test('the settings file is written 0600 — it holds secrets', { skip: process.platform === 'win32' }, () => {
  const s = store().load();
  s.update({ deezer: { arl: 'cookie-value' } });
  assert.strictEqual(fs.statSync(s.file).mode & 0o777, 0o600);
});

test('invalid values are rejected and nothing is written', () => {
  const s = store().load();
  assert.throws(() => s.update({ artnet: { port: 99999 } }));
  assert.throws(() => s.update({ analysis: { analyzerTimeoutMs: 5 } }));
  assert.throws(() => s.update({ nope: { x: 1 } }), /Unrecognized key/);
  assert.strictEqual(s.get('artnet.port'), DEFAULTS.artnet.port);
  assert.ok(!fs.existsSync(s.file), 'a rejected update must not create the file');
});

// Saving this from the UI would make the server refuse to start, leaving no UI
// to undo it from.
test('a non-loopback bind with no token is refused', () => {
  const s = store().load();
  assert.throws(() => s.update({ server: { host: '0.0.0.0' } }), /access token/);
  assert.deepStrictEqual(s.update({ server: { host: '0.0.0.0', token: 'tok' } }).sort(),
    ['server.host', 'server.token'], 'allowed once a token comes with it');
});

test('a corrupt file is moved aside rather than losing the show to a parse error', () => {
  const s = store();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ not json');
  s.load();
  assert.deepStrictEqual(s.group('artnet'), DEFAULTS.artnet, 'falls back to defaults');
  const siblings = fs.readdirSync(path.dirname(s.file));
  assert.ok(siblings.some((f) => f.includes('.invalid-')), 'the bad file is kept for recovery');
});

// A file written before a key existed must still load.
test('a file from an older build gains new keys as defaults', () => {
  const s = store();
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  s.load();
  assert.strictEqual(s.get('artnet.host'), '10.0.0.9');
  assert.strictEqual(s.get('analysis.downloadTimeoutMs'), DEFAULTS.analysis.downloadTimeoutMs);
});

test('pendingRestart reports only bootstrap keys that drifted', () => {
  const s = store().load();
  const boot = { server: { host: '127.0.0.1', port: 3000, token: '' }, engine: { thread: 'worker' } };
  assert.deepStrictEqual(s.pendingRestart(boot), []);
  s.update({ server: { port: 4000 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port']);
  s.update({ artnet: { universe: 4 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port'], 'live keys never need a restart');
  // The engine picks its thread once, at start.
  s.update({ engine: { thread: 'main' } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port', 'engine.thread']);
});

// A leftover .env would otherwise go quiet: the rig comes up on defaults with
// no clue why.
test('legacy env vars are named as ignored, not silently dropped', () => {
  const lines = [];
  const found = warnAboutLegacyEnv({ ARTNET_HOST: '1.2.3.4', DEEZER_ARL: 'x', PATH: '/usr/bin' },
    (m) => lines.push(m));
  assert.deepStrictEqual(found, ['ARTNET_HOST', 'DEEZER_ARL'], 'unrelated vars ignored');
  assert.match(lines.join('\n'), /no longer read/);
  assert.deepStrictEqual(warnAboutLegacyEnv({}, () => {}), [], 'silent when there is no .env');
});

// The application id is the DTLS identity and is stored alongside the keys.
// Unlike them it is not a secret, so it stays readable by the settings page.
test('the Hue application id round-trips and is not redacted', () => {
  const s = store().load();
  s.update({ hue: { bridges: [{ ...BRIDGE, applicationId: 'a966c4cc-018d-4422-aad8-414843fc4fad' }] } });
  assert.strictEqual(
    s.redacted().settings.hue.bridges[0].applicationId,
    'a966c4cc-018d-4422-aad8-414843fc4fad',
  );
});

test('the Hue pars delay defaults to off and refuses a value in the wrong unit', () => {
  assert.strictEqual(DEFAULTS.hue.latencyMs, 0, 'nothing is delayed until someone tunes it');
  const hue = (latencyMs) => schema.safeParse({ ...DEFAULTS, hue: { ...DEFAULTS.hue, latencyMs } }).success;
  assert.ok(hue(60));
  assert.ok(!hue(600), 'over half a second is seconds typed as milliseconds');
  assert.ok(!hue(-1));
});

test('the separator defaults to Demucs and takes only the two it knows', () => {
  assert.strictEqual(DEFAULTS.analysis.separator, 'demucs', 'the one that keeps up with a live set');
  const sep = (separator) => schema.safeParse({ ...DEFAULTS, analysis: { ...DEFAULTS.analysis, separator } }).success;
  assert.ok(sep('bs-roformer'));
  assert.ok(!sep('roformer'));
  assert.ok(!sep(''));
});

test('SongFormer runs by default only where it keeps up, and the field takes only its three', () => {
  assert.strictEqual(DEFAULTS.analysis.structureModel, 'auto', 'on a GPU, not on a CPU');
  const mode = (structureModel) => schema.safeParse({ ...DEFAULTS, analysis: { ...DEFAULTS.analysis, structureModel } }).success;
  for (const ok of ['auto', 'songformer', 'off']) assert.ok(mode(ok), ok);
  assert.ok(!mode('edmformer'), 'no weights were ever released');
  assert.ok(!mode(''));
});

test('the models wait in RAM on a small card by default, and the field takes only its three', () => {
  assert.strictEqual(DEFAULTS.analysis.gpuMemory, 'auto');
  const mode = (gpuMemory) => schema.safeParse({ ...DEFAULTS, analysis: { ...DEFAULTS.analysis, gpuMemory } }).success;
  for (const ok of ['auto', 'offload', 'resident']) assert.ok(mode(ok), ok);
  assert.ok(!mode('vram'));
  assert.ok(!mode(''));
});

// Whatever pythonPath names is executed, so it has to be named like a Python.
test('pythonPath only accepts a Python interpreter', () => {
  const ok = (v) => patchSchema.safeParse({ analysis: { pythonPath: v } }).success;
  for (const v of ['', 'python', 'py', '/usr/bin/python3', '/opt/bin/python3.12',
    'C:\\Users\\me\\miniconda3\\python.exe', 'pythonw.exe']) {
    assert.strictEqual(ok(v), true, v);
  }
  for (const v of ['C:\\Windows\\System32\\cmd.exe', '/bin/sh', 'python3; rm -rf /',
    '/tmp/auto-analyze-1.exe', 'C:\\Temp\\python.exe.bat']) {
    assert.strictEqual(ok(v), false, v);
  }
});

// A rule added later must not quarantine the whole file — credentials and all
// — over one field an older build accepted.
test('a stored pythonPath the new rule refuses is cleared, and the rest loads', () => {
  const s = store();
  fs.writeFileSync(s.file, JSON.stringify({
    analysis: { pythonPath: 'C:\\tools\\run-analyser.bat' },
    spotify: { clientId: 'keep-me' },
  }));
  s.load();
  assert.strictEqual(s.get('analysis.pythonPath'), '');
  assert.strictEqual(s.get('spotify.clientId'), 'keep-me');
  assert.ok(fs.existsSync(s.file), 'not moved aside');
});

test('live input settings: off by default, a source it knows, a latency in range', () => {
  assert.deepStrictEqual(DEFAULTS.live, { enabled: false, source: 'loopback', device: '', latencyMs: 0, autoSync: true, director: true });
  const s = store().load();
  assert.deepStrictEqual(s.update({ live: { enabled: true, source: 'input', device: 'Line In', latencyMs: -40 } }).sort(),
    ['live.device', 'live.enabled', 'live.latencyMs', 'live.source']);
  assert.throws(() => s.update({ live: { source: 'microphone' } }));
  assert.throws(() => s.update({ live: { latencyMs: 2000 } }));
  assert.strictEqual(s.get('live.source'), 'input', 'a refused update changes nothing');
});

// The first-run wizard is offered on a fresh install and not to a rig set up
// before it existed.
test('a fresh install has not been set up; a file from before the wizard has', () => {
  const fresh = store().load();
  assert.strictEqual(fresh.get('setup.completed'), false);
  fresh.update({ artnet: { host: '10.0.0.5' } });
  assert.strictEqual(new SettingsStore(fresh.file).load().get('setup.completed'), false, 'still offered after a save');

  const old = store();
  fs.writeFileSync(old.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  old.load();
  assert.strictEqual(old.get('setup.completed'), true);
  assert.strictEqual(old.get('artnet.host'), '10.0.0.9');

  fresh.update({ setup: { completed: true } });
  assert.strictEqual(new SettingsStore(fresh.file).load().get('setup.completed'), true);
});

// Automatic tempo match is on unless the operator switched it off, and stays
// how it was left across a restart.
test('the tempo mode follows the music by default, takes only its two, and survives a reload', () => {
  assert.deepStrictEqual(DEFAULTS.clock, { tempoMode: 'auto' });
  const s = store().load();
  assert.deepStrictEqual(s.update({ clock: { tempoMode: 'manual' } }), ['clock.tempoMode']);
  assert.strictEqual(new SettingsStore(s.file).load().get('clock.tempoMode'), 'manual');
  assert.throws(() => s.update({ clock: { tempoMode: 'sometimes' } }));
  assert.strictEqual(s.get('clock.tempoMode'), 'manual', 'a refused update changes nothing');

  const older = store();
  fs.mkdirSync(path.dirname(older.file), { recursive: true });
  fs.writeFileSync(older.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  assert.strictEqual(older.load().get('clock.tempoMode'), 'auto', 'a file from before the switch follows the music');
});

// The party effects' safety and Hue settings: Hue Dynamics' 350 ms limit, the
// photosensitivity acknowledgement nobody has given yet, the latched strobe's
// minute, and Hue lamps flashed rather than pulsed.
test('the effect safety and Hue strobe settings have their defaults, their bounds and survive a reload', () => {
  assert.deepStrictEqual(DEFAULTS.safety, { flashLimit: false, hdFlashIntervalMs: 350, photosensitivityAcknowledged: false, strobeMaxLatchSec: 60 });
  assert.strictEqual(DEFAULTS.hue.strobe, 'flash');

  const older = store();
  fs.writeFileSync(older.file, JSON.stringify({ safety: { flashLimit: true }, hue: { bridges: [], latencyMs: 20 } }));
  older.load();
  assert.deepStrictEqual(older.group('safety'), { flashLimit: true, hdFlashIntervalMs: 350, photosensitivityAcknowledged: false, strobeMaxLatchSec: 60 },
    'a file from before the settings keeps its own and gains the defaults');
  assert.strictEqual(older.get('hue.strobe'), 'flash');

  const s = store().load();
  assert.deepStrictEqual(s.update({ safety: { hdFlashIntervalMs: 0, photosensitivityAcknowledged: true, strobeMaxLatchSec: 0.5 }, hue: { strobe: 'pulse' } }).sort(),
    ['hue.strobe', 'safety.hdFlashIntervalMs', 'safety.photosensitivityAcknowledged', 'safety.strobeMaxLatchSec']);
  const reloaded = new SettingsStore(s.file).load();
  assert.strictEqual(reloaded.get('hue.strobe'), 'pulse');
  assert.strictEqual(reloaded.get('safety.hdFlashIntervalMs'), 0, 'zero turns the limit off');
  assert.strictEqual(reloaded.get('safety.photosensitivityAcknowledged'), true);
  s.update({ hue: { strobe: 'flash' } });
  assert.strictEqual(new SettingsStore(s.file).load().get('hue.strobe'), 'flash', 'both modes persist');

  for (const bad of [{ safety: { hdFlashIntervalMs: -1 } }, { safety: { hdFlashIntervalMs: Infinity } }, { safety: { hdFlashIntervalMs: NaN } },
    { safety: { hdFlashIntervalMs: '350' } }, { safety: { strobeMaxLatchSec: 0 } }, { safety: { strobeMaxLatchSec: -5 } },
    { safety: { strobeMaxLatchSec: Infinity } }, { safety: { photosensitivityAcknowledged: 'yes' } }, { hue: { strobe: 'blink' } }]) {
    assert.throws(() => s.update(bad), JSON.stringify(bad));
    assert.strictEqual(patchSchema.safeParse(bad).success, false, `the patch schema refuses ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(s.get('safety.strobeMaxLatchSec'), 0.5, 'a refused update changes nothing');
  assert.ok(patchSchema.safeParse({ safety: { hdFlashIntervalMs: 1200.5 }, hue: { strobe: 'pulse' } }).success, 'a partial patch of the new keys');
});

// The manual strobe's settings, which a cue keeps beside its look: Hue
// Dynamics' manual strobe (two flashes a second on the beat, the look between
// them, 100 ms on and 100 ms black) in white. Its colours are a palette of
// their own, never a parameter of the kind.
test('the strobe\'s settings: Hue Dynamics\' defaults in white, one to five flashes a second, one to six colours', () => {
  assert.deepStrictEqual(DEFAULTS.strobe, {
    flashesPerSecond: 2, continueBetween: true, clock: 'beat', brightness: 1, onMs: 100, blackMs: 100, palette: ['#FFFFFF'],
  });
  const older = store();
  fs.writeFileSync(older.file, JSON.stringify({ artnet: { host: '10.0.0.9' } }));
  assert.deepStrictEqual(older.load().group('strobe'), DEFAULTS.strobe, 'a file from before them gains the defaults');

  const s = store().load();
  assert.deepStrictEqual(s.update({ strobe: { flashesPerSecond: 5, clock: 'wall', palette: ['#FF0000', '#0000FF80'] } }).sort(),
    ['strobe.clock', 'strobe.flashesPerSecond', 'strobe.palette']);
  assert.deepStrictEqual(new SettingsStore(s.file).load().get('strobe.palette'), ['#FF0000', '#0000FF80']);
  for (const bad of [{ strobe: { flashesPerSecond: 6 } }, { strobe: { flashesPerSecond: 0 } }, { strobe: { flashesPerSecond: 2.5 } },
    { strobe: { brightness: 1.5 } }, { strobe: { onMs: 50 } }, { strobe: { clock: 'bar' } },
    { strobe: { palette: [] } }, { strobe: { palette: Array(7).fill('#FFFFFF') } }, { strobe: { palette: ['random'] } }, { strobe: { colour: '#FFFFFF' } }]) {
    assert.throws(() => s.update(bad), JSON.stringify(bad));
  }
  assert.strictEqual(s.get('strobe.flashesPerSecond'), 5, 'a refused update changes nothing');
});
