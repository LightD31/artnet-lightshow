import { state, getClientState } from '../state.ts';
import { applyPatch } from '../patch.ts';
import { deezerStateSchema, validate } from '../validation.ts';
import { settings } from '../settings.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import { listLiveDevices } from '../../live-input.ts';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * The playback sources the show follows: PRO DJ LINK, Spotify (its sign-in,
 * playlists and what is playing), the OS media session, the Deezer browser
 * extension, and the audio devices the live input can hear.
 */
export function attachSourceRoutes(app: Express, ctx: RouteContext): void {
  const { spotify, nowPlaying, deezerSource, integrations } = ctx;

  // ─── PRO DJ LINK ──────────────────────────────────────────────────────────
  app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true });  res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });

  // ─── Spotify ──────────────────────────────────────────────────────────────
  app.get('/auth/spotify', (_req, res) => {
    if (!spotify.configured) {
      // Not env vars: settings.js deliberately never reads process.env, so
      // pointing the operator at one would send them somewhere that cannot work.
      return res.status(400).json({
        ok: false,
        error: 'Add a Spotify client ID and secret under Sources → Spotify first',
      });
    }
    res.redirect(spotify.getAuthorizeUrl());
  });

  app.get('/auth/spotify/callback', asyncHandler(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return res.status(400).type('text/plain').send('Missing authorization code');

    // Bind this callback to a flow this server started. Without it, any page
    // could navigate the operator's browser here with an attacker's code and
    // silently bind the show to the attacker's account.
    if (!spotify.consumeState(req.query.state)) {
      if (settings.get('spotify.allowUnverifiedState')) {
        console.warn(
          '[spotify] callback state missing or unrecognised — accepted because '
          + '"accept unverified state" is enabled. This disables OAuth CSRF protection.'
        );
      } else {
        console.warn('[spotify] rejected callback: missing or unrecognised state parameter');
        return res.status(400).type('text/plain').send(
          'Spotify auth failed: missing or unrecognised state parameter. '
          + 'Start the flow from /auth/spotify in this browser.'
          + (spotify.usingProxy
            ? ' If your OAuth proxy does not forward the state parameter, either clear '
              + 'the proxy (Spotify accepts a 127.0.0.1 redirect directly, and the state '
              + 'then round-trips intact) or enable "Allow Unverified State" under '
              + 'Sources → Spotify — the latter disables OAuth CSRF protection.'
            : '')
        );
      }
    }

    try {
      await spotify.exchangeCode(code);
      spotify.startPolling();
      console.log('Spotify authenticated successfully');
      integrations.broadcast();
      res.send('<html><body style="background:#0d0d0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#44ff88">Spotify Connected</h2><p>You can close this window and return to the lightshow.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
    } catch (err) {
      console.error('Spotify auth error:', messageOf(err));
      // Plain text: the message can carry whatever Spotify or a proxy sent
      // back, and as HTML on this origin it would run in the operator's browser.
      res.status(500).type('text/plain').send(`Spotify auth failed: ${messageOf(err)}`);
    }
  }));

  app.post('/api/spotify/disconnect', (_req, res) => {
    // The operator asked to disconnect, so drop the saved session too —
    // otherwise the next restart would silently sign back in.
    spotify.disconnect({ forget: true });
    integrations.clearSpotifyNext();
    integrations.broadcast();
    res.json({ ok: true });
  });

  /**
   * The connected account's playlists, so warming can offer a picker instead of
   * demanding a pasted link. Private ones need the playlist scope — a
   * connection older than it gets the public subset, and `canReadPlaylists`
   * on the Spotify status tells the UI to offer a reconnect.
   */
  app.get('/api/spotify/playlists', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    try {
      const playlists = await spotify.getMyPlaylists();
      res.json({ ok: true, playlists, canReadPlaylists: spotify.canReadPlaylists });
    } catch (err) {
      res.status(statusOf(err) === 401 ? 400 : 502).json({ ok: false, error: messageOf(err) });
    }
  }));

  app.get('/api/spotify/now-playing', asyncHandler(async (_req, res) => {
    try {
      const playing = await spotify.getCurrentlyPlaying();
      res.json({ ok: true, playing });
    } catch (err) {
      res.status(500).json({ ok: false, error: messageOf(err) });
    }
  }));

  // ─── Now playing (OS media session) ─────────────────────────────────────────
  app.post('/api/nowplaying/disconnect', (_req, res) => {
    nowPlaying.disconnect();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // ─── Deezer (browser extension) ─────────────────────────────────────────────
  // No CORS headers here on purpose. The extension POSTs from its background
  // script (see browser-extension/background.js), which holds a host permission
  // and is therefore not subject to page CORS at all. A wildcard
  // Access-Control-Allow-Origin used to sit here and let any website on the
  // internet push fake now-playing state into the show.

  // The Firefox extension POSTs the Deezer web player's state here: the current
  // track (with ISRC + position) and the upcoming queue (for prefetch).
  app.post('/api/deezer/state', (req, res) => {
    try {
      integrations.onDeezerState(validate(deezerStateSchema, req.body || {}, 'deezer-state'));
      res.json({ ok: true, status: deezerSource.getStatus() });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/deezer/disconnect', (_req, res) => {
    integrations.onDeezerDisconnect();
    res.json({ ok: true });
  });

  // The audio devices the live input can hear: outputs for loopback, inputs
  // for a line-in. Asks the Python service, so it also says whether one of its
  // capture libraries is installed.
  app.get('/api/live/devices', asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await listLiveDevices()) });
    } catch (err) {
      res.json({ ok: false, error: messageOf(err) });
    }
  }));
}
