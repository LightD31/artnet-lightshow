import crypto from 'node:crypto';
import { HttpError, messageOf, statusOf } from './errors.ts';
import type { NowPlaying, PlayingListener } from './types/playback.ts';

class SpotifyError extends HttpError {
  retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(status, message);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

interface SpotifyTrackItem {
  id?: string;
  name?: string;
  type?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
  album?: { name?: string; images?: { url?: string }[] };
  external_ids?: { isrc?: string };
  preview_url?: string | null;
}

interface SpotifyPlayingItem {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url?: string }[] };
  duration_ms: number;
  external_ids?: { isrc?: string };
  preview_url?: string | null;
}

interface SpotifyPlaylistEntry {
  item?: SpotifyTrackItem | null;
  track?: SpotifyTrackItem | null;
  is_local?: boolean;
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
  total?: number;
}

interface SpotifyPlaylistSummary {
  id?: string;
  name?: string;
  owner?: { display_name?: string };
  items?: { total?: number };
  tracks?: { total?: number };
}

export interface SpotifyTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface PlaylistTrack {
  trackId: string | null;
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
  isrc: string | null;
  isLocal: boolean;
}

export interface SpotifyQueueTrack {
  trackId: string;
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  durationMs: number;
  isrc: string | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string;
  total: number;
  truncated: boolean;
  tracks: PlaylistTrack[];
}

const REQUEST_TIMEOUT_MS = 10000;

const DEFAULT_RETRY_AFTER_MS = 5000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

const PLAYLIST_PAGE_SIZE = 100;

const MAX_PLAYLIST_TRACKS = 500;

interface SpotifyConfig {
  clientId?: string;
  clientSecret?: string;
  proxyBase?: string;
}

const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 32;

const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

const PLAYLIST_ID_RE = /^[A-Za-z0-9]{16,40}$/;

const PLAYLIST_URI_RE = /^spotify:playlist:([A-Za-z0-9]+)$/;
const PLAYLIST_URL_RE = /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?playlist\/([A-Za-z0-9]+)/i;

function parsePlaylistRef(input: unknown): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const uri = raw.match(PLAYLIST_URI_RE);
  if (uri) return uri[1];
  const url = raw.match(PLAYLIST_URL_RE);
  if (url) return url[1];
  return PLAYLIST_ID_RE.test(raw) ? raw : null;
}

function playlistItemToTrack(item: SpotifyPlaylistEntry | null | undefined): PlaylistTrack | null {
  const track = item && (item.item || item.track);
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

function notYourPlaylistError(): HttpError {
  return new HttpError(403, 'Spotify only lists the tracks of playlists you own or collaborate on. '
    + 'Copy it into one of your own playlists (Add to other playlist), or paste the tracks as a set list.');
}

class SpotifyClient {
  declare clientId: string;
  declare clientSecret: string;
  declare proxyBase: string;
  declare loopbackPort: number;
  declare redirectUri: string;
  declare localCallbackUrl: string;
  declare accessToken: string | null;
  declare refreshToken: string | null;
  declare expiresAt: number;
  declare _refreshTimer: ReturnType<typeof setTimeout> | null;
  declare _pollTimer: ReturnType<typeof setInterval> | null;
  declare _currentTrackId: string | null;
  declare _onTrackChange: PlayingListener | null;
  declare _onPlaybackUpdate: PlayingListener | null;
  declare _onTokens: ((refreshToken: string) => void) | null;
  declare _pendingStates: Map<string, number>;
  declare _playlistApi: 'items' | 'tracks' | null;
  declare _rateLimitedUntil: number;
  declare _lastErrorLogAt: number;
  declare grantedScopes: Set<string>;

  declare static parsePlaylistRef: typeof parsePlaylistRef;
  declare static playlistItemToTrack: typeof playlistItemToTrack;
  declare static MAX_PLAYLIST_TRACKS: number;
  declare static SCOPES: string[];

  constructor(config: SpotifyConfig = {}) {
    this.clientId = '';
    this.clientSecret = '';
    this.proxyBase = '';
    this.loopbackPort = 3000;
    // Reuse the exact redirect URI because token exchange must match the authorization request.
    this.redirectUri = '';
    this.configure(config);
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
    this._pendingStates = new Map();
    this._playlistApi = null;
    this._rateLimitedUntil = 0;
    this._lastErrorLogAt = 0;
    this.grantedScopes = new Set();
  }

  configure({ clientId, clientSecret, proxyBase }: SpotifyConfig = {}): this {
    if (clientId !== undefined) this.clientId = clientId || '';
    if (clientSecret !== undefined) this.clientSecret = clientSecret || '';
    if (proxyBase !== undefined) this.proxyBase = (proxyBase || '').replace(/\/+$/, '');
    this._refreshRedirectUri();
    return this;
  }

  get usingProxy(): boolean { return !!this.proxyBase; }

  get loopbackRedirectUri(): string {
    return `http://127.0.0.1:${this.loopbackPort}/auth/spotify/callback`;
  }

  _refreshRedirectUri(): void {
    this.redirectUri = this.usingProxy
      ? `${this.proxyBase}/api/v1/spotify/proxy/callback`
      : this.loopbackRedirectUri;
  }

  setLoopbackPort(port: unknown): this {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) this.loopbackPort = n;
    this._refreshRedirectUri();
    return this;
  }

  get loginUrl(): string { return `${this.proxyBase}/api/v1/spotify/proxy/login`; }

  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  get authenticated(): boolean {
    return !!(this.accessToken && Date.now() < this.expiresAt);
  }

  get canReadPlaylists(): boolean {
    return this.grantedScopes.has('playlist-read-private');
  }

  getAuthorizeUrl(): string {
    const state = crypto.randomBytes(24).toString('base64url');
    this._pruneStates();
    while (this._pendingStates.size >= MAX_PENDING_STATES) {
      this._pendingStates.delete(this._pendingStates.keys().next().value as string);
    }
    this._pendingStates.set(state, Date.now());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES.join(' '),
      state,
      redirect_uri: this.usingProxy ? this.localCallbackUrl : this.loopbackRedirectUri,
    });
    return this.usingProxy
      ? `${this.loginUrl}?${params}`
      : `${SPOTIFY_AUTHORIZE_URL}?${params}`;
  }

  consumeState(state: unknown): boolean {
    this._pruneStates();
    if (typeof state !== 'string' || !state || !this._pendingStates.has(state)) return false;
    this._pendingStates.delete(state);
    return true;
  }

  get hasPendingState(): boolean {
    this._pruneStates();
    return this._pendingStates.size > 0;
  }

  _pruneStates(): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [nonce, issuedAt] of this._pendingStates) {
      if (issuedAt < cutoff) this._pendingStates.delete(nonce);
    }
  }

  async exchangeCode(code: string): Promise<SpotifyTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    }).toString();
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    return data;
  }

  async refreshAccessToken(): Promise<SpotifyTokens> {
    if (!this.refreshToken) throw new Error('No refresh token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    }).toString();
    const data = await this._tokenRequest(body);
    this._setTokens(data);
    return data;
  }

  async getCurrentlyPlaying(): Promise<NowPlaying | null> {
    if (!this.authenticated) {
      if (this.refreshToken) await this.refreshAccessToken();
      else return null;
    }
    const sentAt = Date.now();
    const data = await this._apiGet<{ item?: SpotifyPlayingItem | null; progress_ms: number; is_playing: boolean }>(
      '/v1/me/player/currently-playing');
    const receivedAt = Date.now();
    if (!data || !data.item) return null;
    return {
      sampledAt: Math.round((sentAt + receivedAt) / 2),
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

  async getQueue(): Promise<SpotifyQueueTrack[] | null> {
    if (!this.authenticated) {
      if (this.refreshToken) await this.refreshAccessToken();
      else return null;
    }
    const data = await this._apiGet<{ queue?: SpotifyTrackItem[] }>('/v1/me/player/queue');
    if (!data || !Array.isArray(data.queue)) return null;
    return data.queue
      .filter((item): item is SpotifyTrackItem & { id: string } => !!(item && item.id && item.type === 'track'))
      .map((item): SpotifyQueueTrack => ({
        trackId: item.id,
        name: item.name as string,
        artist: (item.artists || []).map(a => a.name).join(', '),
        album: item.album?.name || '',
        albumArt: item.album?.images?.[0]?.url || null,
        durationMs: item.duration_ms as number,
        isrc: item.external_ids?.isrc || null,
      }));
  }

  async getPlaylist(ref: unknown, { limit = MAX_PLAYLIST_TRACKS } = {}): Promise<SpotifyPlaylist> {
    const id = parsePlaylistRef(ref);
    if (!id) {
      throw new HttpError(400, 'Not a Spotify playlist link, URI or id');
    }
    await this._ensureAuth();

    const cap = Math.min(Math.max(1, Math.floor(limit) || 0), MAX_PLAYLIST_TRACKS);

    const head = await this._apiGet<{ name?: string; owner?: { display_name?: string } }>(
      `/v1/playlists/${id}?fields=${encodeURIComponent('name,owner(display_name)')}`
    );
    if (!head) {
      throw new HttpError(404, 'Spotify returned nothing for that playlist');
    }

    const tracks: PlaylistTrack[] = [];
    let walked = 0;
    let hasMore = true;
    let total: number | null = null;

    while (hasMore && walked < cap) {
      const pageSize = Math.min(PLAYLIST_PAGE_SIZE, cap - walked);
      const page = await this._playlistPage(id, pageSize, walked);
      if (page && typeof page.total === 'number' && Number.isFinite(page.total)) total = page.total;
      const returned = page && Array.isArray(page.items) ? page.items : [];
      if (!returned.length) break;
      const items = returned.slice(0, pageSize);
      for (const item of items) {
        const track = playlistItemToTrack(item);
        if (track) tracks.push(track);
      }
      walked += items.length;
      hasMore = !!(page && page.next);
    }

    total = total ?? walked;
    return {
      id,
      name: head.name || 'Playlist',
      owner: head.owner?.display_name || '',
      total,
      truncated: hasMore && walked < total,
      tracks,
    };
  }

  async _playlistPage(id: string, limit: number, offset: number): Promise<SpotifyPage<SpotifyPlaylistEntry> | null> {
    const trackFields = 'id,name,type,duration_ms,artists(name),album(name,images),external_ids(isrc)';
    const apis: { path: 'items' | 'tracks'; entry: string }[] = this._playlistApi === 'tracks'
      ? [{ path: 'tracks', entry: 'track' }]
      : [{ path: 'items', entry: 'item' }, { path: 'tracks', entry: 'track' }];

    for (const [i, api] of apis.entries()) {
      const fields = `next,total,items(is_local,${api.entry}(${trackFields}))`;
      try {
        const page = await this._apiGet<SpotifyPage<SpotifyPlaylistEntry>>(
          `/v1/playlists/${id}/${api.path}?limit=${limit}&offset=${offset}`
          + `&fields=${encodeURIComponent(fields)}`
        );
        this._playlistApi = api.path;
        return page;
      } catch (err) {
        if (statusOf(err) === 403) throw notYourPlaylistError();
        if (statusOf(err) === 404 && i < apis.length - 1) continue;
        throw err;
      }
    }
    return null;
  }

  async getMyPlaylists({ limit = 100 } = {}): Promise<{ id: string; name: string; owner: string; total: number }[]> {
    await this._ensureAuth();
    const cap = Math.min(Math.max(1, Math.floor(limit) || 0), 200);
    const out: { id: string; name: string; owner: string; total: number }[] = [];
    // Advance by the returned page size so filtered entries cannot repeat a page forever.
    let offset = 0;
    while (offset < cap) {
      const pageSize = Math.min(50, cap - offset);
      const page = await this._apiGet<SpotifyPage<SpotifyPlaylistSummary>>(`/v1/me/playlists?limit=${pageSize}&offset=${offset}`);
      const items = (page && Array.isArray(page.items) ? page.items : []).slice(0, pageSize);
      if (!items.length) break;
      offset += items.length;
      for (const pl of items) {
        if (!pl || !pl.id) continue;
        out.push({
          id: pl.id,
          name: pl.name || 'Untitled playlist',
          owner: pl.owner?.display_name || '',
          total: pl.items?.total ?? pl.tracks?.total ?? 0,
        });
      }
      if (!page || !page.next) break;
    }
    return out;
  }

  async _ensureAuth(): Promise<void> {
    if (this.authenticated) return;
    if (!this.refreshToken) {
      throw new HttpError(401, 'Spotify not connected');
    }
    await this.refreshAccessToken();
  }

  startPolling(intervalMs = 2000): void {
    this.stopPolling();
    const timer = setInterval(async () => {
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
    if (timer.unref) timer.unref();
    this._pollTimer = timer;
  }

  _noteRequestError(err: unknown): void {
    if (statusOf(err) === 429) {
      const waitMs = (err as SpotifyError).retryAfterMs || DEFAULT_RETRY_AFTER_MS;
      this._rateLimitedUntil = Date.now() + waitMs;
      console.warn(`[spotify] rate limited — backing off ${Math.round(waitMs / 1000)}s`);
      return;
    }
    const now = Date.now();
    if (now - this._lastErrorLogAt > 60000) {
      this._lastErrorLogAt = now;
      console.warn(`[spotify] ${err instanceof Error && err.message ? err.message : err}`);
    }
  }

  stopPolling(): void {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  onTrackChange(fn: PlayingListener | null): void { this._onTrackChange = fn; }
  onPlaybackUpdate(fn: PlayingListener | null): void { this._onPlaybackUpdate = fn; }

  onTokens(fn: ((refreshToken: string) => void) | null): void { this._onTokens = fn; }

  async restoreSession(refreshToken: string | null | undefined): Promise<boolean> {
    if (!refreshToken || !this.configured) return false;
    this.refreshToken = refreshToken;
    try {
      await this.refreshAccessToken();
    } catch (err) {
      this.accessToken = null;
      this.expiresAt = 0;
      const status = statusOf(err);
      if (status !== undefined && status >= 400 && status < 500) {
        this.refreshToken = null;
        this._emitTokens('');
      }
      throw err;
    }
    return this.authenticated;
  }

  disconnect({ forget = false } = {}): void {
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

  getStatus(): { configured: boolean; authenticated: boolean; canReadPlaylists: boolean; currentTrackId: string | null } {
    return {
      configured: this.configured,
      authenticated: this.authenticated,
      canReadPlaylists: this.canReadPlaylists,
      currentTrackId: this._currentTrackId,
    };
  }

  _setTokens(data: SpotifyTokens): void {
    if (data.access_token) this.accessToken = data.access_token;
    if (typeof data.scope === 'string') {
      this.grantedScopes = new Set(data.scope.split(/\s+/).filter(Boolean));
    }
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      this._emitTokens(this.refreshToken);
    }
    if (data.expires_in) {
      this.expiresAt = Date.now() + data.expires_in * 1000 - 60000; // 1 min buffer
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      const timer = setTimeout(() => {
        this.refreshAccessToken().catch((err) => this._noteRequestError(err));
      }, (data.expires_in - 120) * 1000);
      if (timer.unref) timer.unref();
      this._refreshTimer = timer;
    }
  }

  _emitTokens(token: string): void {
    if (!this._onTokens) return;
    try { this._onTokens(token); }
    catch (err) { console.warn(`[spotify] could not save the session: ${messageOf(err)}`); }
  }

  _tokenRequest(body: string): Promise<SpotifyTokens> {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    return this._request<SpotifyTokens>('POST', 'https://accounts.spotify.com/api/token', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    }, body) as Promise<SpotifyTokens>;
  }

  _apiGet<T>(path: string): Promise<T | null> {
    return this._request<T>('GET', `https://api.spotify.com${path}`, {
      'Authorization': `Bearer ${this.accessToken}`,
    });
  }

  async _request<T>(method: string, urlStr: string, headers: Record<string, string>, body?: string): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(urlStr, {
        method,
        headers: { ...headers },
        body: body || undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
      const wrapped = new Error(
        name === 'TimeoutError' || name === 'AbortError'
          ? `Spotify request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `Spotify request failed: ${messageOf(err)}`
      );
      wrapped.cause = err;
      throw wrapped;
    }

    if (res.status === 429) {
      throw new SpotifyError(429, 'Spotify rate limit hit', this._parseRetryAfter(res.headers.get('retry-after')));
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SpotifyError(res.status, `Spotify API ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text) as T; } catch { return null; }
  }

  _parseRetryAfter(header: string | null): number {
    const seconds = Number.parseInt(header ?? '', 10);
    if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
}

SpotifyClient.parsePlaylistRef = parsePlaylistRef;
SpotifyClient.playlistItemToTrack = playlistItemToTrack;
SpotifyClient.MAX_PLAYLIST_TRACKS = MAX_PLAYLIST_TRACKS;
SpotifyClient.SCOPES = SCOPES;

export default SpotifyClient;