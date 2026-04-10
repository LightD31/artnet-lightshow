'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

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
  }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  get authenticated() {
    return !!(this.accessToken && Date.now() < this.expiresAt);
  }

  /** Build the proxy login URL for the user to visit. */
  getAuthorizeUrl() {
    const scopes = 'user-read-playback-state user-read-currently-playing';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes,
      // Proxy forwards the code to this local URL after Spotify OAuth completes
      redirect_uri: this.localCallbackUrl,
    });
    return `${PROXY_LOGIN_URL}?${params}`;
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
      try {
        const playing = await this.getCurrentlyPlaying();
        if (!playing) return;

        if (this._onPlaybackUpdate) this._onPlaybackUpdate(playing);

        if (playing.trackId !== this._currentTrackId) {
          this._currentTrackId = playing.trackId;
          if (this._onTrackChange) this._onTrackChange(playing);
        }
      } catch (_) { /* ignore transient errors */ }
    }, intervalMs);
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
        this.refreshAccessToken().catch(() => {});
      }, (data.expires_in - 120) * 1000);
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

  _request(method, urlStr, headers, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const opts = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { ...headers },
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 204 || !data) return resolve(null);
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = SpotifyClient;
