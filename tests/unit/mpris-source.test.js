// The Linux "now playing": MPRIS players on the session bus, read through
// busctl, handed on in the same shape as the Windows media session's. A fake
// busctl answers in the JSON busctl prints (checked against busctl 255 on a
// real session bus), so the parsing is tested on what the reader will see.

import test from 'node:test';
import assert from 'node:assert';

import MprisReader, { parsePlayer, appOf } from '../../src/mpris-source.ts';
import { osNowPlayingKind, createOsNowPlaying } from '../../src/os-now-playing.ts';

const s = (data) => ({ type: 's', data });
const metadata = ({ title, artist = ['Daft Punk'], album = 'Discovery', length = 320_000_000, art = null }) => ({
  type: 'a{sv}',
  data: {
    'mpris:trackid': { type: 'o', data: '/org/mpris/MediaPlayer2/Track/1' },
    ...(length !== null ? { 'mpris:length': { type: 'x', data: length } } : {}),
    ...(title !== undefined ? { 'xesam:title': s(title) } : {}),
    'xesam:artist': Array.isArray(artist) ? { type: 'as', data: artist } : s(artist),
    'xesam:album': s(album),
    ...(art ? { 'mpris:artUrl': s(art) } : {}),
  },
});

/**
 * A busctl that answers from `players`: name → { status, meta, position } or
 * { error } for a player that fails; `positionError` makes Position fail.
 */
function fakeBus(players, { listCode = 0 } = {}) {
  const calls = [];
  const busctl = async (args) => {
    calls.push(args);
    if (args.includes('ListNames')) {
      if (listCode !== 0) return { code: listCode, stdout: '', stderr: 'Failed to connect to bus: No medium found\n' };
      return { code: 0, stdout: `${JSON.stringify({ type: 'as', data: [['org.freedesktop.DBus', ':1.4', ...Object.keys(players)]] })}\n`, stderr: '' };
    }
    const name = args[args.indexOf('get-property') + 1];
    const p = players[name];
    if (!p || p.error) return { code: 1, stdout: '', stderr: 'Failed to get property: Unknown object\n' };
    if (p.positionError && args.includes('Position')) return { code: 1, stdout: '', stderr: 'Failed to get property Position: Not supported\n' };
    const lines = [s(p.status), metadata(p.meta)];
    if (args.includes('Position')) lines.push({ type: 'x', data: p.position ?? 0 });
    return { code: 0, stdout: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', stderr: '' };
  };
  return { busctl, calls };
}

function reader(bus, clock = { t: 1_000_000 }) {
  const r = new MprisReader({ busctl: bus.busctl, now: () => clock.t });
  const seen = [];
  r.onUpdate((p) => seen.push(p));
  r.onIdle(() => seen.push('idle'));
  return { r, seen, clock };
}

test('a player\'s state comes out of busctl\'s JSON: the metadata, microseconds to milliseconds', async () => {
  const bus = fakeBus({
    'org.mpris.MediaPlayer2.spotify': {
      status: 'Playing', position: 61_500_000,
      meta: { title: 'One More Time', artist: ['Daft Punk', 'Romanthony'], art: 'https://i.scdn.co/image/ab67' },
    },
  });
  const { r, seen } = reader(bus);
  assert.strictEqual(await r.poll(), 500);
  assert.deepStrictEqual(seen, [{
    trackId: 'mpris:daft punk, romanthony|one more time',
    name: 'One More Time', artist: 'Daft Punk, Romanthony', album: 'Discovery',
    albumArt: 'https://i.scdn.co/image/ab67',
    durationMs: 320000, progressMs: 61500, isPlaying: true, isrc: null, sourceApp: 'spotify',
  }]);
  assert.deepStrictEqual(bus.calls[1], ['--user', '--json=short', 'get-property', 'org.mpris.MediaPlayer2.spotify',
    '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'PlaybackStatus', 'Metadata', 'Position']);
});

test('what players send loosely is read anyway, and a local file is no album art', () => {
  const lines = [s('Paused'), metadata({ title: 'Song', artist: 'Solo Artist', length: null, art: 'file:///tmp/cover.jpg' })];
  const player = parsePlayer('org.mpris.MediaPlayer2.vlc', lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepStrictEqual([player.artist, player.lengthUs, player.positionUs, player.artUrl], ['Solo Artist', 0, 0, null]);
  assert.strictEqual(parsePlayer('x', 'not json'), null);
  assert.strictEqual(parsePlayer('x', ''), null);
  assert.strictEqual(appOf('org.mpris.MediaPlayer2.firefox.instance_1_42'), 'firefox');
  assert.strictEqual(appOf('org.mpris.MediaPlayer2.chromium.instance12345'), 'chromium');
  assert.strictEqual(appOf('org.mpris.MediaPlayer2.spotify'), 'spotify');
});

test('the playing player is followed over a paused one, and stays followed while it plays', async () => {
  const players = {
    'org.mpris.MediaPlayer2.firefox.instance_1_7': { status: 'Paused', meta: { title: 'A video' } },
    'org.mpris.MediaPlayer2.spotify': { status: 'Playing', meta: { title: 'Aerodynamic' } },
  };
  const { r, seen, clock } = reader(fakeBus(players));
  await r.poll();
  assert.strictEqual(seen.at(-1).name, 'Aerodynamic');

  // A second player starts: the newer one is the one the room is hearing.
  players['org.mpris.MediaPlayer2.firefox.instance_1_7'].status = 'Playing';
  clock.t += 500;
  await r.poll();
  assert.strictEqual(seen.at(-1).name, 'Aerodynamic', 'the one already followed keeps it while it plays');
  players['org.mpris.MediaPlayer2.spotify'].status = 'Paused';
  clock.t += 500;
  await r.poll();
  assert.strictEqual(seen.at(-1).name, 'A video');
  assert.strictEqual(seen.at(-1).sourceApp, 'firefox');
});

test('with nothing playing, the one that played last is reported paused; with no track, idle', async () => {
  const players = {
    'org.mpris.MediaPlayer2.spotify': { status: 'Playing', meta: { title: 'Digital Love' } },
    'org.mpris.MediaPlayer2.vlc': { status: 'Paused', meta: { title: 'Old film' } },
  };
  const { r, seen, clock } = reader(fakeBus(players));
  await r.poll();
  players['org.mpris.MediaPlayer2.spotify'].status = 'Paused';
  clock.t += 500;
  await r.poll();
  assert.deepStrictEqual([seen.at(-1).name, seen.at(-1).isPlaying], ['Digital Love', false]);

  players['org.mpris.MediaPlayer2.spotify'].meta = { title: undefined };
  players['org.mpris.MediaPlayer2.vlc'].status = 'Stopped';
  clock.t += 500;
  await r.poll();
  assert.strictEqual(seen.at(-1), 'idle');
});

test('a player that does not do Position is asked without it', async () => {
  const bus = fakeBus({ 'org.mpris.MediaPlayer2.mpv': { status: 'Playing', positionError: true, meta: { title: 'Take' } } });
  const { r, seen } = reader(bus);
  await r.poll();
  await r.poll();
  assert.deepStrictEqual(seen.map((p) => [p.name, p.progressMs]), [['Take', 0], ['Take', 0]]);
  const asks = bus.calls.filter((c) => c.includes('get-property'));
  assert.deepStrictEqual(asks.map((c) => c.includes('Position')), [true, false, false], 'once with it, then never');
});

test('the list of players is asked for every few seconds, the players every poll', async () => {
  const bus = fakeBus({ 'org.mpris.MediaPlayer2.spotify': { status: 'Playing', meta: { title: 'Voyager' } } });
  const { r, clock } = reader(bus);
  for (let i = 0; i < 4; i++) { await r.poll(); clock.t += 500; }
  assert.strictEqual(bus.calls.filter((c) => c.includes('ListNames')).length, 1);
  clock.t += 3000;
  await r.poll();
  assert.strictEqual(bus.calls.filter((c) => c.includes('ListNames')).length, 2);
});

test('no session bus, or no busctl, is said once and tried again later', async () => {
  const warn = console.warn;
  const said = [];
  console.warn = (line) => said.push(line);
  try {
    const { r } = reader(fakeBus({}, { listCode: 1 }));
    assert.strictEqual(await r.poll(), 15000);
    assert.strictEqual(await r.poll(), 15000);
    assert.strictEqual(said.length, 1, said.join('\n'));
    assert.match(said[0], /no session bus to read \(Failed to connect to bus: No medium found\)/);

    const missing = new MprisReader({ busctl: async () => { throw Object.assign(new Error('spawn busctl ENOENT'), { code: 'ENOENT' }); } });
    assert.strictEqual(await missing.poll(), 15000);
    assert.match(said[1], /busctl was not found; it comes with systemd/);
  } finally {
    console.warn = warn;
  }
});

test('each platform reads its own session: SMTC on Windows, MPRIS on Linux, none on macOS', () => {
  assert.strictEqual(osNowPlayingKind('win32'), 'SMTC');
  assert.strictEqual(osNowPlayingKind('linux'), 'MPRIS');
  assert.strictEqual(osNowPlayingKind('freebsd'), 'MPRIS');
  assert.strictEqual(osNowPlayingKind('darwin'), null);
  assert.ok(createOsNowPlaying('linux') instanceof MprisReader);
  assert.ok(!(createOsNowPlaying('win32') instanceof MprisReader));
});
