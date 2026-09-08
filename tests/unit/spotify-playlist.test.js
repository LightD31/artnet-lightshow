'use strict';

const test = require('node:test');
const assert = require('node:assert');

const SpotifyClient = require('../../src/spotify');

const { parsePlaylistRef, playlistItemToTrack, MAX_PLAYLIST_TRACKS } = SpotifyClient;

// ── Playlist references ─────────────────────────────────────────────────────
// Whatever the operator pastes: the share link, the URI, or the bare id.

const ID = '37i9dQZF1DXcBWIGoYBM5M';

test('a share link, a URI and a bare id all name the same playlist', () => {
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com/playlist/${ID}`), ID);
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com/playlist/${ID}?si=8f2b1c`), ID);
  assert.strictEqual(parsePlaylistRef(`spotify:playlist:${ID}`), ID);
  assert.strictEqual(parsePlaylistRef(ID), ID);
  assert.strictEqual(parsePlaylistRef(`  ${ID}  `), ID, 'a pasted id keeps its whitespace');
});

// The desktop share sheet inserts a locale segment in some regions.
test('the /intl-xx segment the share sheet adds is ignored', () => {
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com/intl-fr/playlist/${ID}?si=x`), ID);
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com/intl-pt-br/playlist/${ID}`), ID);
});

test('anything that is not a playlist reference is refused', () => {
  assert.strictEqual(parsePlaylistRef(''), null);
  assert.strictEqual(parsePlaylistRef(null), null);
  assert.strictEqual(parsePlaylistRef('Daft Punk - Around the World'), null);
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com/album/${ID}`), null, 'an album is not a playlist');
  assert.strictEqual(parsePlaylistRef(`spotify:track:${ID}`), null, 'a track is not a playlist');
});

// The id is interpolated into an API path, so a reference that would smuggle
// path or query characters through must not parse at all.
test('a reference that would escape the API path does not parse', () => {
  assert.strictEqual(parsePlaylistRef(`${ID}/../../me/player`), null);
  assert.strictEqual(parsePlaylistRef(`https://evilspotify.com/playlist/${ID}`), null);
  assert.strictEqual(parsePlaylistRef(`https://open.spotify.com.attacker.net/playlist/${ID}`), null);
  assert.match(parsePlaylistRef(`https://open.spotify.com/playlist/${ID}?si=x`), /^[A-Za-z0-9]+$/);
});

// ── Playlist items ──────────────────────────────────────────────────────────

const trackItem = (over = {}) => ({
  is_local: false,
  track: {
    id: 'abc123',
    name: 'Around the World',
    type: 'track',
    duration_ms: 428000,
    artists: [{ name: 'Daft Punk' }],
    album: { name: 'Homework', images: [{ url: 'http://img/1' }] },
    external_ids: { isrc: 'GBDUW0000059' },
    ...over,
  },
});

test('a playlist track carries the id, ISRC and duration the warmer wants', () => {
  assert.deepStrictEqual(playlistItemToTrack(trackItem()), {
    trackId: 'abc123',
    name: 'Around the World',
    artist: 'Daft Punk',
    album: 'Homework',
    albumArt: 'http://img/1',
    durationMs: 428000,
    isrc: 'GBDUW0000059',
    isLocal: false,
  });
});

test('several artists are joined the way every other source joins them', () => {
  const item = trackItem({ artists: [{ name: 'Justice' }, { name: 'Uffie' }] });
  assert.strictEqual(playlistItemToTrack(item).artist, 'Justice, Uffie');
});

// A playlist is not just tracks.
test('episodes and entries with nothing left to analyse are dropped', () => {
  assert.strictEqual(playlistItemToTrack({ track: null }), null, 'removed from the catalogue');
  assert.strictEqual(playlistItemToTrack(null), null);
  assert.strictEqual(playlistItemToTrack({ track: { name: 'Ep. 12', type: 'episode' } }), null);
  assert.strictEqual(playlistItemToTrack({ track: { id: 'x', type: 'track' } }), null, 'no name');
});

// A local file has no Spotify id, but it has a title and an artist, which is
// all a set-list line has either — so it is warmed the same way.
test('a local file is kept and falls back to a search by name', () => {
  const local = playlistItemToTrack({
    is_local: true,
    track: {
      id: null, name: 'Untitled Edit', type: 'track', duration_ms: 300000,
      artists: [{ name: 'Bootleg' }], album: { name: '' },
    },
  });

  assert.strictEqual(local.trackId, null);
  assert.strictEqual(local.isLocal, true);
  assert.strictEqual(local.name, 'Untitled Edit');
  assert.strictEqual(local.artist, 'Bootleg');
});

// ── Fetching a playlist ─────────────────────────────────────────────────────

/**
 * A client with a live token and a scripted API. `pages` maps a path substring
 * to the body to answer with; `calls` records what was asked for.
 */
function fakeClient({ head, pages = [], scopes = 'playlist-read-private' } = {}) {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  client.accessToken = 'token';
  client.expiresAt = Date.now() + 60000;
  client.grantedScopes = new Set(String(scopes).split(/\s+/).filter(Boolean));
  const calls = [];
  let page = 0;
  client._apiGet = async (path) => {
    calls.push(path);
    if (path.includes('/tracks?')) return pages[page++] ?? { items: [], next: null };
    return head;
  };
  return { client, calls };
}

const page = (items, next = null) => ({ items, next, total: items.length });

test('a playlist comes back as tracks, named and counted', async () => {
  const { client, calls } = fakeClient({
    head: { name: 'Friday', owner: { display_name: 'Léa' }, tracks: { total: 2 } },
    pages: [page([trackItem(), trackItem({ id: 'def456', name: 'Genesis' })])],
  });

  const playlist = await client.getPlaylist(`https://open.spotify.com/playlist/${ID}`);

  assert.strictEqual(playlist.id, ID);
  assert.strictEqual(playlist.name, 'Friday');
  assert.strictEqual(playlist.owner, 'Léa');
  assert.strictEqual(playlist.total, 2);
  assert.strictEqual(playlist.truncated, false);
  assert.deepStrictEqual(playlist.tracks.map((t) => t.trackId), ['abc123', 'def456']);
  // Only the fields we render or warm — a full playlist page is mostly market
  // availability lists we would throw away.
  assert.ok(calls.every((c) => c.includes('fields=')), 'every read is field-limited');
});

test('a playlist longer than one page is walked to the end', async () => {
  const first = Array.from({ length: 100 }, (_, i) => trackItem({ id: `a${i}`, name: `Track ${i}` }));
  const { client, calls } = fakeClient({
    head: { name: 'Long', tracks: { total: 150 } },
    pages: [page(first, 'next-url'), page([trackItem({ id: 'b0', name: 'Last' })])],
  });

  const playlist = await client.getPlaylist(ID);

  assert.strictEqual(playlist.tracks.length, 101);
  assert.strictEqual(playlist.truncated, false, 'the last page had no next');
  assert.ok(calls.some((c) => c.includes('offset=100')), 'the second page is asked for by offset');
});

// Warming caps a run anyway; someone's 4000-track library should not become
// forty API calls, and the caller has to be able to say what it left out.
test('a playlist past the limit stops early and says so', async () => {
  const full = Array.from({ length: 100 }, (_, i) => trackItem({ id: `a${i}` }));
  const { client, calls } = fakeClient({
    head: { name: 'Everything', tracks: { total: 4000 } },
    pages: [page(full, 'next-url'), page(full, 'next-url'), page(full, 'next-url')],
  });

  const playlist = await client.getPlaylist(ID, { limit: 150 });

  assert.strictEqual(playlist.tracks.length, 150);
  assert.strictEqual(playlist.truncated, true);
  assert.strictEqual(calls.filter((c) => c.includes('/tracks?')).length, 2);
  assert.ok(calls.some((c) => c.includes('limit=50')), 'the last page asks only for the remainder');
});

test('the limit is clamped to the ceiling however it is asked for', async () => {
  const { client } = fakeClient({
    head: { name: 'X', tracks: { total: 1 } },
    pages: [page([trackItem()])],
  });

  // Not an assertion about the result so much as about not walking 4000 tracks
  // because a caller passed Infinity.
  const playlist = await client.getPlaylist(ID, { limit: 10 ** 9 });
  assert.ok(playlist.tracks.length <= MAX_PLAYLIST_TRACKS);
});

test('a reference that is not a playlist fails before spending a request', async () => {
  const { client, calls } = fakeClient({ head: {} });

  await assert.rejects(
    () => client.getPlaylist('Daft Punk - Around the World'),
    (err) => err.status === 400 && /not a spotify playlist/i.test(err.message),
  );
  assert.strictEqual(calls.length, 0);
});

test('reading a playlist while disconnected says so rather than returning nothing', async () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });

  await assert.rejects(() => client.getPlaylist(ID), (err) => err.status === 401);
  await assert.rejects(() => client.getMyPlaylists(), (err) => err.status === 401);
});

// ── The account's own playlists ─────────────────────────────────────────────

test('the picker list pages until Spotify runs out', async () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  client.accessToken = 'token';
  client.expiresAt = Date.now() + 60000;
  const pages = [
    { items: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `List ${i}`, owner: { display_name: 'me' }, tracks: { total: i } })), next: 'more' },
    { items: [{ id: 'last', name: 'Encore', tracks: { total: 3 } }], next: null },
  ];
  let n = 0;
  client._apiGet = async () => pages[n++] ?? { items: [], next: null };

  const lists = await client.getMyPlaylists();

  assert.strictEqual(lists.length, 51);
  assert.deepStrictEqual(lists[50], { id: 'last', name: 'Encore', owner: '', total: 3 });
});

// A page of playlists we cannot use must still advance the offset, or the
// paging asks for the same page forever.
test('a page of unusable entries does not loop', async () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  client.accessToken = 'token';
  client.expiresAt = Date.now() + 60000;
  let calls = 0;
  client._apiGet = async () => {
    calls++;
    if (calls > 10) throw new Error('paged forever');
    return { items: Array.from({ length: 50 }, () => ({ name: 'no id' })), next: 'more' };
  };

  const lists = await client.getMyPlaylists({ limit: 100 });

  assert.deepStrictEqual(lists, []);
  assert.strictEqual(calls, 2, 'two pages of 50 exhausts the limit');
});

// ── Scopes ──────────────────────────────────────────────────────────────────
// Spotify answers 404, not 403, for a playlist the token cannot see, so the
// only way to tell an operator why their own playlist "does not exist" is to
// remember what was granted.

test('granted scopes are read off the token response', () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  assert.strictEqual(client.canReadPlaylists, false, 'nothing granted yet');

  client._setTokens({
    access_token: 'a', refresh_token: 'r',
    scope: 'user-read-currently-playing playlist-read-private playlist-read-collaborative',
  });
  assert.strictEqual(client.canReadPlaylists, true);
  assert.strictEqual(client.getStatus().canReadPlaylists, true);

  // A connection made before the playlist scopes were requested.
  client._setTokens({ access_token: 'a', scope: 'user-read-currently-playing' });
  assert.strictEqual(client.canReadPlaylists, false);

  client.disconnect();
  assert.strictEqual(client.canReadPlaylists, false);
});

test('login asks for the playlist scopes', () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  const url = client.getAuthorizeUrl();
  const scope = new URL(url).searchParams.get('scope');

  assert.ok(scope.includes('playlist-read-private'), scope);
  assert.ok(scope.includes('playlist-read-collaborative'), scope);
  // Playback still has to work — the playlist scopes are additions, not a swap.
  assert.ok(scope.includes('user-read-playback-state'), scope);
});

// ── OAuth: proxy optional ───────────────────────────────────────────────────
//
// Spotify requires HTTPS for redirect URIs with one exception: loopback IP
// literals. `http://127.0.0.1:PORT` is accepted; `http://localhost:PORT` was
// dropped in February 2025 because localhost resolution varies. So the relay
// that used to be mandatory is only needed to authorise from a device other
// than the one running the server — and the default is now to go direct.

test('with no proxy the flow goes straight to Spotify on a loopback redirect', () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  client.setLoopbackPort(3000);

  assert.strictEqual(client.usingProxy, false);

  const url = new URL(client.getAuthorizeUrl());
  assert.strictEqual(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');

  // The literal, not `localhost` and not whatever server.host is set to: this
  // is the only http:// form Spotify will accept, and it is what the operator
  // registers in the dashboard.
  const redirect = url.searchParams.get('redirect_uri');
  assert.strictEqual(redirect, 'http://127.0.0.1:3000/auth/spotify/callback');

  // Spotify checks the token exchange's redirect_uri against the authorize
  // request's, so the two have to be the same string.
  assert.strictEqual(client.redirectUri, redirect);
});

test('the loopback redirect follows the port the server is actually on', () => {
  const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret' });
  client.setLoopbackPort(8080);
  assert.strictEqual(client.redirectUri, 'http://127.0.0.1:8080/auth/spotify/callback');

  // Junk leaves the last good value alone rather than producing a URL that
  // could never match what is registered.
  client.setLoopbackPort('not a port');
  assert.strictEqual(client.redirectUri, 'http://127.0.0.1:8080/auth/spotify/callback');
});

test('a configured proxy still takes the relayed route', () => {
  const client = new SpotifyClient({
    clientId: 'id', clientSecret: 'secret', proxyBase: 'https://relay.example.com/',
  });
  client.localCallbackUrl = 'http://192.168.1.9:3000/auth/spotify/callback';

  assert.strictEqual(client.usingProxy, true);
  // Trailing slash trimmed, so the joined paths never double up.
  assert.strictEqual(client.proxyBase, 'https://relay.example.com');

  const url = new URL(client.getAuthorizeUrl());
  assert.strictEqual(
    url.origin + url.pathname, 'https://relay.example.com/api/v1/spotify/proxy/login',
  );
  // In proxy mode the authorize request names where the proxy forwards to,
  // while the token exchange quotes the proxy's own callback.
  assert.strictEqual(
    url.searchParams.get('redirect_uri'), 'http://192.168.1.9:3000/auth/spotify/callback',
  );
  assert.strictEqual(
    client.redirectUri, 'https://relay.example.com/api/v1/spotify/proxy/callback',
  );
});

test('clearing the proxy in the settings page really turns it off', () => {
  // configure() used to ignore a falsy proxyBase, so emptying the field left
  // the old relay in place and the operator could not get back to direct.
  const client = new SpotifyClient({
    clientId: 'id', clientSecret: 'secret', proxyBase: 'https://relay.example.com',
  });
  assert.strictEqual(client.usingProxy, true);

  client.configure({ proxyBase: '' });
  client.setLoopbackPort(3000);

  assert.strictEqual(client.usingProxy, false);
  assert.strictEqual(client.redirectUri, 'http://127.0.0.1:3000/auth/spotify/callback');
  assert.ok(client.getAuthorizeUrl().startsWith('https://accounts.spotify.com/authorize'));
});

test('the state nonce is issued and checked the same way in both modes', () => {
  // Going direct means the nonce round-trips through Spotify untouched, which
  // is the case the "allow unverified state" escape hatch exists to work
  // around when a relay drops it.
  for (const proxyBase of ['', 'https://relay.example.com']) {
    const client = new SpotifyClient({ clientId: 'id', clientSecret: 'secret', proxyBase });
    const state = new URL(client.getAuthorizeUrl()).searchParams.get('state');

    assert.ok(state, `no state issued with proxyBase="${proxyBase}"`);
    assert.strictEqual(client.consumeState('not-the-nonce'), false);
    assert.strictEqual(client.consumeState(state), true);
    assert.strictEqual(client.consumeState(state), false, 'single use');
  }
});
