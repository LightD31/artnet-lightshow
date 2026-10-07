import { state, getClientState } from '../state.ts';
import { applyPatch } from '../patch.ts';
import { deezerStateSchema, validate } from '../validation.ts';
import { settings } from '../settings.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import { listLiveDevices } from '../../live-input.ts';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

export function attachSourceRoutes(app: Express, ctx: RouteContext): void {
  const { spotify, nowPlaying, deezerSource, integrations } = ctx;

  app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true });  res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });
  app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: (getClientState() as Record<string, unknown>).prolink }); });

  app.get('/auth/spotify', (_req, res) => {
    if (!spotify.configured) {
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
      res.status(500).type('text/plain').send(`Spotify auth failed: ${messageOf(err)}`);
    }
  }));

  app.post('/api/spotify/disconnect', (_req, res) => {
    // Drop the saved session on disconnect so restart cannot silently sign in again.
    spotify.disconnect({ forget: true });
    integrations.clearSpotifyNext();
    integrations.broadcast();
    res.json({ ok: true });
  });

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

  app.post('/api/nowplaying/disconnect', (_req, res) => {
    nowPlaying.disconnect();
    integrations.broadcast();
    res.json({ ok: true });
  });

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

  app.get('/api/live/devices', asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await listLiveDevices()) });
    } catch (err) {
      res.json({ ok: false, error: messageOf(err) });
    }
  }));
}
