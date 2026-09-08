'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, DEFAULTS, warnAboutLegacyEnv } = require('../../src/server/settings');

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
  });

  const { settings, secrets } = s.redacted();
  assert.strictEqual(settings.deezer.arl, '', 'redacted out');
  assert.strictEqual(settings.spotify.clientSecret, '');
  assert.strictEqual(settings.spotify.refreshToken, '');
  assert.deepStrictEqual(secrets, {
    'server.token': false,
    'spotify.clientSecret': true,
    'spotify.refreshToken': true,
    'deezer.arl': true,
  });
  assert.strictEqual(s.get('deezer.arl'), 'cookie-value', 'still readable server-side');
  assert.strictEqual(s.get('spotify.refreshToken'), 'a-live-session');
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
  const boot = { server: { host: '127.0.0.1', port: 3000, token: '' } };
  assert.deepStrictEqual(s.pendingRestart(boot), []);
  s.update({ server: { port: 4000 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port']);
  s.update({ artnet: { universe: 4 } });
  assert.deepStrictEqual(s.pendingRestart(boot), ['server.port'], 'live keys never need a restart');
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
