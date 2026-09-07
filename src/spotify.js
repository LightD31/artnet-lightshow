'use strict';

const crypto = require('crypto');

// Every Spotify call is bounded. The previous hand-rolled https client had no
// timeout at all, so one hung connection leaked a promise that never settled
// while the 1 Hz poller kept stacking more behind it — see AUDIT.md M5.
const REQUEST_TIMEOUT_MS = 10000;

// Spotify returns 429 with a Retry-After (seconds). Polling /currently-playing
// at 1 Hz plus a queue peek every 15 s sits close enough to the limit that this
// matters; without it a rate-limit looked like "Spotify just stopped working".
const DEFAULT_RETRY_AFTER_MS = 5000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Spotify Web API client with OAuth2 Authorization Code flow.
 *
 * Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars.
 *
 * Spotify no longer allows plain HTTP redirect URIs, so OAuth goes through
 * an HTTPS proxy (api.drndvs.fr) which handles the Spotify callback and then
 * forwards the authorization code back to our local HTTP server.
 *
 * Register this URL in your Spotify app dashboard as the allowed redirect URI:
 *   https://api.drndvs.fr/api/v1/spotify/proxy/callback
 *
 * Override with SPOTIFY_PROXY_BASE env var to use a different proxy.
 */
const PROXY_BASE = process.env.SPOTIFY_PROXY_BASE || 'https://api.drndvs.fr';
const PROXY_LOGIN_URL = `${PROXY_BASE}/api/v1/spotify/proxy/login`;

// How long an issued OAuth state nonce stays valid. Long enough to log in and
// approve the scopes, short enough that a leaked authorize URL goes stale.
const STATE_TTL_MS = 10 * 60 * 1000;
const PROXY_CALLBACK_URL = `${PROXY_BASE}/api/v1/spotify/proxy/callback`;

class SpotifyClient {
  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
    // The redirect_uri used in the Spotify token exchange — must match the one
    // the proxy used when redirecting to Spotify (i.e. the proxy's own callback).
    this.redirectUri = PROXY_CALLBACK_URL;
    // The local URL the proxy forwards the code to — set by server after port is known.
    this.localCallbackUrl = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._refreshTimer = null;
    this._pollTimer = null;
    this._currentTrackId = null;
    this._onTrackChange = null;
    this._onPlaybackUpdate = null;
    // Pending OAuth state nonces → issue time. Without this the callback
    // accepts any code presented to it, so any page could bind this server to
    // an attacker's Spotify account — see AUDIT.md H3.
    this._pendingStates = new Map();
    // Set while a 429 backoff window is in effect.
    this._rateLimitedUntil = 0;
    this._lastErrorLogAt = 0;
  }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  get authenticated() {
    return !!(this.accessToken && Date.now() < this.expiresAt);
  }

  /**
   * Build the proxy login URL for the user to visit. Issues a single-use state
   * nonce that consumeState() must later match, binding the callback to a flow
   * this server actually started.
   */
  getAuthorizeUrl() {
    const scopes = 'user-read-playback-state user-read-currently-playing';
    const state = crypto.randomBytes(24).toString('base64url');
    this._pruneStates();
    this._pendingStates.set(state, Date.now());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes,
      state,
      // Proxy forwards the code to this local URL after Spotify OAuth completes
      redirect_uri: this.localCallbackUrl,
    });
    return `${PROXY_LOGIN_URL}?${params}`;
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

  /** Disconnect and clear tokens. */
  disconnect() {
    this.stopPolling();
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._currentTrackId = null;
    this._pendingStates.clear();
    this._rateLimitedUntil = 0;
  }

  getStatus() {
    return {
      configured: this.configured,
      authenticated: this.authenticated,
      currentTrackId: this._currentTrackId,
    };
  }

  // ── Internal ─────────────────────────────────────────────

  _setTokens(data) {
    if (data.access_token) this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
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

module.exports = SpotifyClient;
