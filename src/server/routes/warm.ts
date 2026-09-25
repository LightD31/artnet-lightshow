import { validate } from '../validation.ts';
import { warmRequestSchema, warmPlaylistSchema, parseSetList, fromSpotifyTracks, MAX_TRACKS as MAX_WARM_TRACKS } from '../warm.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * Set-list warming: analysing a night's tracks before it starts.
 */
export function attachWarmRoutes(app: Express, ctx: RouteContext): void {
  const { spotify, integrations } = ctx;

  // ─── Set-list warming ─────────────────────────────────────────────────────
  // Analyse a whole night up front. Live prefetch only sees one to five tracks
  // ahead, and only once something is playing.
  app.get('/api/warm', (_req, res) => res.json({ ok: true, warm: integrations.warmer.status() }));

  app.post('/api/warm', (req, res) => {
    try {
      const body = validate(warmRequestSchema, req.body || {}, 'warm');
      const inputs = [...(body.tracks || []), ...parseSetList(body.text)];
      if (!inputs.length) {
        return res.status(400).json({ ok: false, error: 'Provide a set list as `text` or `tracks`' });
      }
      res.json({ ok: true, warm: integrations.warmer.start(inputs) });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  /** Warm everything Spotify has queued, rather than only the next few. */
  app.post('/api/warm/spotify-queue', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    const queue = await spotify.getQueue();
    if (!queue || !queue.length) return res.status(400).json({ ok: false, error: 'Spotify queue is empty' });

    try {
      res.json({ ok: true, warm: integrations.warmer.start(fromSpotifyTracks(queue)) });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  }));

  /**
   * Warm a Spotify playlist.
   *
   * The queue only exists once something is playing and rarely holds a whole
   * night; a playlist is the set list most people already have. Takes a share
   * link, a Spotify URI or a bare id.
   */
  app.post('/api/warm/spotify-playlist', asyncHandler(async (req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });

    let body;
    try {
      body = validate(warmPlaylistSchema, req.body || {}, 'warm playlist');
    } catch (err) { return res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }

    let playlist;
    try {
      playlist = await spotify.getPlaylist(body.playlist, { limit: MAX_WARM_TRACKS });
    } catch (err) {
      // Spotify answers 404 for a playlist you cannot see, which is also what a
      // private playlist looks like without the scope. Say which it probably is
      // rather than leaving the operator to guess at a bare "not found".
      if (statusOf(err) === 404 && !spotify.canReadPlaylists) {
        return res.status(400).json({
          ok: false,
          error: 'Playlist not found. If it is private or collaborative, reconnect '
            + 'Spotify — this connection predates the playlist permission.',
        });
      }
      // A bad reference or a lapsed connection is the caller's to fix; a real
      // 404 is the playlist's; anything else is Spotify failing on our behalf.
      const status = statusOf(err) === 400 || statusOf(err) === 401 ? 400
        : statusOf(err) === 404 ? 404
          : 502;
      return res.status(status).json({ ok: false, error: messageOf(err) });
    }

    const inputs = fromSpotifyTracks(playlist.tracks);
    if (!inputs.length) {
      return res.status(400).json({
        ok: false,
        error: `"${playlist.name}" has no tracks to warm`,
      });
    }

    try {
      res.json({
        ok: true,
        playlist: {
          id: playlist.id, name: playlist.name, owner: playlist.owner,
          total: playlist.total, truncated: playlist.truncated,
        },
        warm: integrations.warmer.start(inputs),
      });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  }));

  app.delete('/api/warm', (_req, res) => {
    const cancelled = integrations.warmer.cancel();
    if (!cancelled) integrations.warmer.clear();
    res.json({ ok: true, cancelled, warm: integrations.warmer.status() });
  });
}
