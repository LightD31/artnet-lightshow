'use strict';

const crypto = require('crypto');

// Every Spotify call is bounded. The previous hand-rolled https client had no
// timeout at all, so one hung connection leaked a promise that never settled
// while the 1 Hz poller kept stacking more behind it.
const REQUEST_TIMEOUT_MS = 10000;

// Spotify returns 429 with a Retry-After (seconds). Polling /currently-playing
// at 1 Hz plus a queue peek every 15 s sits close enough to the limit that this
// matters; without it a rate-limit looked like "Spotify just stopped working".
const DEFAULT_RETRY_AFTER_MS = 5000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

// Playlist reads are paged. 100 is Spotify's maximum page size for
// /playlists/{id}/tracks, so this is the fewest round trips the API allows.
const PLAYLIST_PAGE_SIZE = 100;

// Ceiling on how much of a playlist we will walk. The warmer caps a run at 200
// tracks anyway, and someone's 4000-track "everything" playlist should not turn
// one button press into forty API calls.
const MAX_PLAYLIST_TRACKS = 500;

/**
 * Scopes requested at login.
 *
 * The two playlist scopes exist for set-list warming: reading a *public*
 * playlist needs no scope at all, but a private or collaborative one is
 * invisible without them — and Spotify answers 404 rather than 403, so without
 * the scope your own playlist simply appears not to exist. A connection made
 * before these were added keeps working for playback; warming a private
 * playlist from it needs a reconnect, which `canReadPlaylists` reports.
 */
const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
];

/**
 * Spotify Web API client with OAuth2 Authorization Code flow.
 *
 * Requires a client ID and secret, set in the settings page under Spotify.
 *
 * Spotify no longer allows plain HTTP redirect URIs, so OAuth goes through
 * an HTTPS proxy (api.drndvs.fr) which handles the Spotify callback and then
 * forwards the authorization code back to our local HTTP server.
 *
 * Register this URL in your Spotify app dashboard as the allowed redirect URI:
 *   https://api.drndvs.fr/api/v1/spotify/proxy/callback
 *
 * Change the proxy in the settings page (Spotify → OAuth proxy) to use another.
 */

// How long an issued OAuth state nonce stays valid. Long enough to log in and
// approve the scopes, short enough that a leaked authorize URL goes stale.
const STATE_TTL_MS = 10 * 60 * 1000;

// Spotify's own authorize endpoint, used when no OAuth proxy is configured.
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

// Spotify ids are base-62 and 22 characters today, but the length has never
// been part of the contract, so accept a range rather than pinning 22.
const PLAYLIST_ID_RE = /^[A-Za-z0-9]{16,40}$/;

// "Copy link to playlist" gives a URL, "Copy Spotify URI" gives a URI, and the
// desktop app's share sheet adds an /intl-xx locale segment in some regions.
const PLAYLIST_URI_RE = /^spotify:playlist:([A-Za-z0-9]+)$/;
const PLAYLIST_URL_RE = /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?playlist\/([A-Za-z0-9]+)/i;

/**
 * Pull the playlist id out of whatever the operator pasted — a share link, a
 * Spotify URI, or the bare id.
 *
 * Returns null for anything else. The id is interpolated into an API path, so
 * only base-62 ever comes back out of here.
 */
function parsePlaylistRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const uri = raw.match(PLAYLIST_URI_RE);
  if (uri) return uri[1];
  const url = raw.match(PLAYLIST_URL_RE);
  if (url) return url[1];
  return PLAYLIST_ID_RE.test(raw) ? raw : null;
}

/**
 * Turn one /playlists/{id}/tracks item into the track summary the rest of the
 * app speaks, or null for an entry there is nothing to analyse in.
 *
 * Playlists are not just tracks: they carry podcast episodes, tracks that have
 * been removed from the catalogue (a null `track`), and local files. Episodes
 * and removed entries are dropped. Local files are kept — they have no Spotify
 * id, but they do have a title and an artist, which is all the warmer needs to
 * find the audio the same way a pasted set list does.
 */
function playlistItemToTrack(item) {
  const track = item && item.track;
  if (!track || !track.name) return null;
  if (track.type && track.type !== 'track') return null;
  return {
    trackId: track.id || null,
    name: track.name,
    artist: (track.artists || []).map((a) => a.name).filter(Boolean).join(', '),
    album: track.album?.name || '',
    albumArt: track.album?.images?.[0]?.url || null,
    durationMs: track.duration_ms || 0,
    isrc: track.external_ids?.isrc || null,
    isLocal: !!item.is_local,
  };
}

class SpotifyClient {
  constructor(config = {}) {
    this.clientId = '';
    this.clientSecret = '';
    // Blank means talk to Spotify directly, which is the normal case — see
    // loopbackRedirectUri. A proxy is only needed to authorise from a device
    // that is not the one running the server.
    this.proxyBase = '';
    // The port this server is listening on, for the loopback redirect. Set by
    // the server once it is known; 3000 matches the settings default so the
    // value is never nonsense before then.
    this.loopbackPort = 3000;
    // The redirect_uri sent in the Spotify token exchange. It must be byte-for
    // byte the one the authorize request used, so both come from one place.
    this.redirectUri = '';
    this.configure(config);
    // The local URL the proxy forwards the code to — set by server after port
    // is known. Only used in proxy mode.
    this.localCallbackUrl = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._refreshTimer = null;
    this._pollTimer = null;
    this._currentTrackId = null;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
    this._onTokens = null;
    // Pending OAuth state nonces → issue time. Without this the callback
    // accepts any code presented to it, so any page could bind this server to
    // an attacker's Spotify account.
    this._pendingStates = new Map();
    // Set while a 429 backoff window is in effect.
    this._rateLimitedUntil = 0;
    this._lastErrorLogAt = 0;
    // Scopes Spotify actually granted, as reported by the token response. A
    // token issued before a scope was added to SCOPES will not carry it.
    this.grantedScopes = new Set();
  }

  /**
   * Apply credentials from the settings store. Called at boot and again
   * whenever the settings page saves, so editing the client id or the proxy
   * takes effect without a restart. Only keys actually present are changed.
   */
  configure({ clientId, clientSecret, proxyBase } = {}) {
    if (clientId !== undefined) this.clientId = clientId || '';
    if (clientSecret !== undefined) this.clientSecret = clientSecret || '';
    // Assigned even when blank, so clearing the proxy in the settings page
    // actually turns it off rather than leaving the last value in place.
    if (proxyBase !== undefined) this.proxyBase = (proxyBase || '').replace(/\/+$/, '');
    this._refreshRedirectUri();
    return this;
  }

  /** True when the OAuth round trip goes through a relay instead of Spotify. */
  get usingProxy() { return !!this.proxyBase; }

  /**
   * Where Spotify sends the browser back to when no proxy is configured.
   *
   * Spotify requires HTTPS for redirect URIs with exactly one exception:
   * loopback IP literals. `http://127.0.0.1:PORT` is accepted (as is
   * `http://[::1]:PORT`), while `http://localhost:PORT` was dropped in
   * February 2025 because localhost resolution varies between machines. So a
   * rig whose operator authorises from the machine running the server needs no
   * relay at all — which is why the proxy is optional and off by default.
   *
   * The literal is deliberate: it is what Spotify accepts and what has to be
   * registered in the app dashboard, whatever `server.host` happens to be.
   */
  get loopbackRedirectUri() {
    return `http://127.0.0.1:${this.loopbackPort}/auth/spotify/callback`;
  }

  _refreshRedirectUri() {
    this.redirectUri = this.usingProxy
      ? `${this.proxyBase}/api/v1/spotify/proxy/callback`
      : this.loopbackRedirectUri;
  }

  /** Tell the client which port to build the loopback redirect from. */
  setLoopbackPort(port) {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) this.loopbackPort = n;
    this._refreshRedirectUri();
    return this;
  }

  /** The proxy's login endpoint. Meaningless without a proxy configured. */
  get loginUrl() { return `${this.proxyBase}/api/v1/spotify/proxy/login`; }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  get authenticated() {
    return !!(this.accessToken && Date.now() < this.expiresAt);
  }

  /**
   * Whether this connection can see private and collaborative playlists.
   *
   * False for a session authorised before the playlist scopes were requested:
   * everything else keeps working, and warming a private playlist needs a
   * reconnect.
   */
  get canReadPlaylists() {
    return this.grantedScopes.has('playlist-read-private');
  }

  /**
   * Build the proxy login URL for the user to visit. Issues a single-use state
   * nonce that consumeState() must later match, binding the callback to a flow
   * this server actually started.
   */
  getAuthorizeUrl() {
    const state = crypto.randomBytes(24).toString('base64url');
    this._pruneStates();
    this._pendingStates.set(state, Date.now());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES.join(' '),
      state,
      // With a proxy this names where the proxy should forward the code once
      // Spotify has called *it* back; the token exchange then quotes the
      // proxy's own callback. Without one there is no such indirection: the
      // same loopback URL goes to Spotify here and to the token endpoint
      // later, which is what Spotify checks them against each other for.
      redirect_uri: this.usingProxy ? this.localCallbackUrl : this.loopbackRedirectUri,
    });
    return this.usingProxy
      ? `${this.loginUrl}?${params}`
      : `${SPOTIFY_AUTHORIZE_URL}?${params}`;
  }

  /**
   * Verify and burn a state nonce from the OAuth callback. Returns true only
   * for a nonce this server issued within STATE_TTL_MS and has not yet used.
   */
  consumeState(state) {
    this._pruneStates();
    if (!state || !this._pendingStates.has(state)) return false;
    this._pendingStates.delete(state);
    return true;
  }

  /** True when at least one authorization flow is currently outstanding. */
  get hasPendingState() {
    this._pruneStates();
    return this._pendingStates.size > 0;
  }

  _pruneStates() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [nonce, issuedAt] of this._pendingStates) {
      if (issuedAt < cutoff) this._pendingStates.delete(nonce);
    }
  }

  /** Exchange an authorization code for access + refresh tokens. */
  async exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    }).toString();
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    return data;
  }

  /** Refresh the access token using the stored refresh token. */
  async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    }).toString();
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    return data;
  }

  /** Get the currently playing track from Spotify. */
  async getCurrentlyPlaying() {
    if (!this.authenticated) {
      if (this.refreshToken) await this.refreshAccessToken();
      else return null;
    }
    const data = await this._apiGet('/v1/me/player/currently-playing');
    if (!data || !data.item) return null;
    return {
      trackId: data.item.id,
      name: data.item.name,
      artist: data.item.artists.map(a => a.name).join(', '),
      album: data.item.album.name,
      albumArt: data.item.album.images[0]?.url || null,
      durationMs: data.item.duration_ms,
      progressMs: data.progress_ms,
      isPlaying: data.is_playing,
      isrc: data.item.external_ids?.isrc || null,
      previewUrl: data.item.preview_url,
    };
  }

  /**
   * Get the upcoming user queue (tracks + auto-queued radio picks).
   * Returns a slim array of track summaries, or null if unauthenticated/empty.
   * Requires the `user-read-playback-state` scope (already in getAuthorizeUrl).
   */
  async getQueue() {
    if (!this.authenticated) {
      if (this.refreshToken) await this.refreshAccessToken();
      else return null;
    }
    const data = await this._apiGet('/v1/me/player/queue');
    if (!data || !Array.isArray(data.queue)) return null;
    return data.queue
      .filter(item => item && item.id && item.type === 'track')
      .map(item => ({
        trackId: item.id,
        name: item.name,
        artist: (item.artists || []).map(a => a.name).join(', '),
        album: item.album?.name || '',
        albumArt: item.album?.images?.[0]?.url || null,
        durationMs: item.duration_ms,
        isrc: item.external_ids?.isrc || null,
      }));
  }

  /**
   * Read a playlist's tracks, for warming a whole night from a playlist rather
   * than the live queue (which only exists once something is playing) or a
   * pasted list (which has to be typed).
   *
   * Accepts a share link, a Spotify URI or a bare id. Pages until the playlist
   * ends or `limit` is reached, and reports `truncated` so the caller can say
   * so rather than silently warming the first N.
   */
  async getPlaylist(ref, { limit = MAX_PLAYLIST_TRACKS } = {}) {
    const id = parsePlaylistRef(ref);
    if (!id) {
      const err = new Error('Not a Spotify playlist link, URI or id');
      err.status = 400;
      throw err;
    }
    await this._ensureAuth();

    const cap = Math.min(Math.max(1, Math.floor(limit) || 0), MAX_PLAYLIST_TRACKS);

    // Ask only for what we render or warm. A playlist page with every field is
    // hundreds of KB per 100 tracks, nearly all of it market availability lists.
    const headFields = 'name,owner(display_name),tracks(total)';
    const head = await this._apiGet(
      `/v1/playlists/${id}?fields=${encodeURIComponent(headFields)}`
    );
    if (!head) {
      const err = new Error('Spotify returned nothing for that playlist');
      err.status = 404;
      throw err;
    }

    const itemFields = 'next,total,items(is_local,track(id,name,type,duration_ms,'
      + 'artists(name),album(name,images),external_ids(isrc)))';
    const tracks = [];
    let walked = 0;
    let hasMore = true;

    while (hasMore && walked < cap) {
      const pageSize = Math.min(PLAYLIST_PAGE_SIZE, cap - walked);
      const page = await this._apiGet(
        `/v1/playlists/${id}/tracks?limit=${pageSize}&offset=${walked}`
        + `&fields=${encodeURIComponent(itemFields)}`
      );
      const returned = page && Array.isArray(page.items) ? page.items : [];
      if (!returned.length) break;
      // Trust the cap over the response: a page that comes back longer than we
      // asked for must not walk us past the limit.
      const items = returned.slice(0, pageSize);
      for (const item of items) {
        const track = playlistItemToTrack(item);
        if (track) tracks.push(track);
      }
      walked += items.length;
      hasMore = !!(page && page.next);
    }

    const total = Number(head.tracks?.total) || walked;
    return {
      id,
      name: head.name || 'Playlist',
      owner: head.owner?.display_name || '',
      total,
      // What we actually walked, before episodes and dead entries were dropped.
      truncated: hasMore && walked < total,
      tracks,
    };
  }

  /**
   * List the playlists the connected account follows or owns, so the UI can
   * offer a picker instead of demanding a pasted link.
   *
   * Private playlists only appear when `playlist-read-private` was granted —
   * see SCOPES. A connection older than that scope gets a short public-only
   * list rather than an error, which is why `canReadPlaylists` is on the status.
   */
  async getMyPlaylists({ limit = 100 } = {}) {
    await this._ensureAuth();
    const cap = Math.min(Math.max(1, Math.floor(limit) || 0), 200);
    const out = [];
    // Paged by what Spotify returned, not by what we kept — an entry can be
    // dropped below, and paging on the kept count would ask for the same
    // offset forever.
    let offset = 0;
    while (offset < cap) {
      const pageSize = Math.min(50, cap - offset);
      const page = await this._apiGet(`/v1/me/playlists?limit=${pageSize}&offset=${offset}`);
      const items = (page && Array.isArray(page.items) ? page.items : []).slice(0, pageSize);
      if (!items.length) break;
      offset += items.length;
      for (const pl of items) {
        if (!pl || !pl.id) continue;
        out.push({
          id: pl.id,
          name: pl.name || 'Untitled playlist',
          owner: pl.owner?.display_name || '',
          total: pl.tracks?.total || 0,
        });
      }
      if (!page.next) break;
    }
    return out;
  }

  /**
   * Make sure there is a usable access token, refreshing if it has expired.
   *
   * Unlike the polling reads, which return null when disconnected because a
   * poller has nothing to say to a person, this throws: every caller is a
   * button someone just pressed and is owed a reason.
   */
  async _ensureAuth() {
    if (this.authenticated) return;
    if (!this.refreshToken) {
      const err = new Error('Spotify not connected');
      err.status = 401;
      throw err;
    }
    await this.refreshAccessToken();
  }

  /** Start polling Spotify for playback changes. */
  startPolling(intervalMs = 2000) {
    this.stopPolling();
    this._pollTimer = setInterval(async () => {
      // Honour a rate-limit window before issuing anything new.
      if (Date.now() < this._rateLimitedUntil) return;
      try {
        const playing = await this.getCurrentlyPlaying();
        if (!playing) return;

        if (this._onPlaybackUpdate) this._onPlaybackUpdate(playing);

        if (playing.trackId !== this._currentTrackId) {
          this._currentTrackId = playing.trackId;
          if (this._onTrackChange) this._onTrackChange(playing);
        }
      } catch (err) {
        this._noteRequestError(err);
      }
    }, intervalMs);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  /**
   * Record a failed request. A 429 parks the poller for the window Spotify
   * asked for; anything else is logged at most once per minute so a persistent
   * outage is visible without flooding the console at 1 Hz.
   */
  _noteRequestError(err) {
    if (err && err.status === 429) {
      const waitMs = err.retryAfterMs || DEFAULT_RETRY_AFTER_MS;
      this._rateLimitedUntil = Date.now() + waitMs;
      console.warn(`[spotify] rate limited — backing off ${Math.round(waitMs / 1000)}s`);
      return;
    }
    const now = Date.now();
    if (now - this._lastErrorLogAt > 60000) {
      this._lastErrorLogAt = now;
      console.warn(`[spotify] ${err && err.message ? err.message : err}`);
    }
  }

  stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  onTrackChange(fn) { this._onTrackChange = fn; }
  onPlaybackUpdate(fn) { this._onPlaybackUpdate = fn; }

  /**
   * Register a callback fired whenever the refresh token changes.
   *
   * That token *is* the session: with it the server can mint access tokens
   * indefinitely without the operator opening a browser again. Spotify may hand
   * back a new one on any refresh, not just at the initial code exchange, so
   * this fires on every change — saving only the first would go quietly stale
   * and the session would die at the next restart with no obvious cause.
   */
  onTokens(fn) { this._onTokens = fn; }

  /**
   * Bring a stored session back after a restart.
   *
   * Only the refresh token is kept. Access tokens last an hour, so re-minting
   * one is both simpler and always right, where a persisted access token would
   * usually be stale by the time the next show starts.
   *
   * Throws with `err.status` set when Spotify rejects the grant — revoked in
   * the account, or issued for different credentials — and without one when the
   * request never got an answer. The caller needs that difference: a rig that
   * boots before its network is up must not have its session deleted.
   */
  async restoreSession(refreshToken) {
    if (!refreshToken || !this.configured) return false;
    this.refreshToken = refreshToken;
    try {
      await this.refreshAccessToken();
    } catch (err) {
      this.accessToken = null;
      this.expiresAt = 0;
      // Keep the token on a network failure so a later attempt can use it;
      // drop it, store included, once Spotify has actually said no. Deciding
      // that here rather than at the call site keeps one rule for "the session
      // is gone" instead of two that can drift apart.
      if (err && err.status >= 400 && err.status < 500) {
        this.refreshToken = null;
        this._emitTokens('');
      }
      throw err;
    }
    return this.authenticated;
  }

  /**
   * Stop polling and clear the session from memory.
   *
   * `forget` also clears the stored one, which is the operator pressing
   * Disconnect. Shutdown must not pass it: this runs on the way down too, and
   * wiping the saved session every time the server stopped would defeat the
   * point of saving it.
   */
  disconnect({ forget = false } = {}) {
    this.stopPolling();
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._currentTrackId = null;
    this._pendingStates.clear();
    this._rateLimitedUntil = 0;
    this.grantedScopes.clear();
    if (forget) this._emitTokens('');
  }

  getStatus() {
    return {
      configured: this.configured,
      authenticated: this.authenticated,
      canReadPlaylists: this.canReadPlaylists,
      currentTrackId: this._currentTrackId,
    };
  }

  // ── Internal ─────────────────────────────────────────────

  _setTokens(data) {
    if (data.access_token) this.accessToken = data.access_token;
    // Spotify echoes the granted scopes on both the code exchange and every
    // refresh. A token minted before a scope was added never gains it, so this
    // is how we know whether playlist reads will work before trying one.
    if (typeof data.scope === 'string') {
      this.grantedScopes = new Set(data.scope.split(/\s+/).filter(Boolean));
    }
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      this._emitTokens(this.refreshToken);
    }
    if (data.expires_in) {
      this.expiresAt = Date.now() + data.expires_in * 1000 - 60000; // 1 min buffer
      // Auto-refresh before expiry
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        this.refreshAccessToken().catch((err) => this._noteRequestError(err));
      }, (data.expires_in - 120) * 1000);
      if (this._refreshTimer.unref) this._refreshTimer.unref();
    }
  }

  /** Hand the refresh token to whoever is storing it, without letting a
   *  failure there take down the request that produced it. */
  _emitTokens(token) {
    if (!this._onTokens) return;
    try { this._onTokens(token); }
    catch (err) { console.warn(`[spotify] could not save the session: ${err.message}`); }
  }

  _tokenRequest(body) {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    return this._request('POST', 'https://accounts.spotify.com/api/token', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    }, body);
  }

  _apiGet(path) {
    return this._request('GET', `https://api.spotify.com${path}`, {
      'Authorization': `Bearer ${this.accessToken}`,
    });
  }

  /**
   * Issue a request and return the parsed JSON body, or null for an empty
   * response (204 and friends).
   *
   * Throws on a non-2xx status with `err.status` set, and on 429 also
   * `err.retryAfterMs` — callers previously got the error body parsed as if it
   * were data, which turned an auth failure into a silent wrong answer.
   */
  async _request(method, urlStr, headers, body) {
    let res;
    try {
      res = await fetch(urlStr, {
        method,
        headers: { ...headers },
        body: body || undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortError from the timeout, DNS failure, connection reset…
      const wrapped = new Error(
        err.name === 'TimeoutError' || err.name === 'AbortError'
          ? `Spotify request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Spotify request failed: ${err.message}`
      );
      wrapped.cause = err;
      throw wrapped;
    }

    if (res.status === 429) {
      const err = new Error('Spotify rate limit hit');
      err.status = 429;
      err.retryAfterMs = this._parseRetryAfter(res.headers.get('retry-after'));
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Spotify API ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      err.status = res.status;
      throw err;
    }

    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  _parseRetryAfter(header) {
    const seconds = Number.parseInt(header, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
}

// Exposed as statics so the routes can validate a pasted reference before
// spending a request on it, and the tests can exercise the parsing directly.
SpotifyClient.parsePlaylistRef = parsePlaylistRef;
SpotifyClient.playlistItemToTrack = playlistItemToTrack;
SpotifyClient.MAX_PLAYLIST_TRACKS = MAX_PLAYLIST_TRACKS;
SpotifyClient.SCOPES = SCOPES;

module.exports = SpotifyClient;
