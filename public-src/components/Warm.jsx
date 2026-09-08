import { useEffect, useState } from 'preact/hooks';
import { stateSig, api, toast } from '../state.js';

// Progress rides the state broadcast, so this component only ever posts.
// Failures surface as toasts via api().
const post = (path, body) => api(`/api/warm${path}`, {
  method: body === undefined ? 'DELETE' : 'POST',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const STATUS_LABEL = {
  pending: 'queued',
  warming: 'analysing…',
  ready: 'cached',
  cached: 'already cached',
  error: 'failed',
  cancelled: 'cancelled',
};

function Progress({ warm }) {
  const pct = warm.total ? Math.round((warm.done / warm.total) * 100) : 0;
  return (
    <div class="warm-progress">
      <div class="warm-bar"><div class="warm-bar-fill" style={{ width: `${pct}%` }} /></div>
      <div class="warm-counts">
        {warm.done} / {warm.total} · {warm.ready} cached
        {warm.failed > 0 && <span class="warm-failed"> · {warm.failed} failed</span>}
        {warm.current && <span class="warm-current"> · {warm.current}</span>}
      </div>
    </div>
  );
}

/**
 * Warm a Spotify playlist: pick one of the account's own, or paste a link to
 * anyone's. The picker is the common case — the set list is usually a playlist
 * the operator already made — and the link covers a playlist someone sent over,
 * which is not in the account's list at all.
 */
function SpotifyPlaylist({ ready, canReadPrivate, running, onWarm }) {
  const [playlists, setPlaylists] = useState(null);   // null = not loaded yet
  const [choice, setChoice] = useState('');
  const [link, setLink] = useState('');

  // Load once, when Spotify is connected. The list is a few dozen entries and
  // does not change during a show, so there is nothing to poll for.
  useEffect(() => {
    if (!ready || playlists !== null) return;
    let cancelled = false;
    api('/api/spotify/playlists').then((r) => {
      if (cancelled) return;
      setPlaylists(r.ok && Array.isArray(r.playlists) ? r.playlists : []);
    });
    return () => { cancelled = true; };
  }, [ready, playlists]);

  if (!ready) return null;

  const ref = link.trim() || choice;

  return (
    <div class="warm-playlist">
      <div class="warm-playlist-row">
        <select
          class="warm-playlist-select"
          value={choice}
          disabled={running || !playlists || !playlists.length}
          onChange={(e) => { setChoice(e.target.value); setLink(''); }}
        >
          <option value="">
            {playlists === null ? 'Loading playlists…'
              : playlists.length ? 'Pick a playlist…'
                : 'No playlists on this account'}
          </option>
          {(playlists || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.total ? ` (${p.total})` : ''}
            </option>
          ))}
        </select>

        <input
          class="warm-playlist-link"
          type="text"
          placeholder="…or paste a playlist link"
          value={link}
          disabled={running}
          onInput={(e) => { setLink(e.target.value); if (e.target.value) setChoice(''); }}
        />

        <button
          class="btn"
          disabled={running || !ref}
          onClick={() => onWarm(ref)}
        >Warm this playlist</button>
      </div>

      {!canReadPrivate && (
        <p class="warm-note">
          This Spotify connection predates the playlist permission, so private and
          collaborative playlists are invisible to it. Reconnect Spotify in settings to
          include them.
        </p>
      )}
    </div>
  );
}

export function Warm() {
  const s = stateSig.value;
  const warm = s.warm || { running: false, total: 0, done: 0, ready: 0, failed: 0, tracks: [] };
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  const spotifyReady = !!(s.spotify && s.spotify.authenticated);
  const canReadPrivate = !!(s.spotify && s.spotify.canReadPlaylists);

  const hasList = warm.tracks && warm.tracks.length > 0;

  // A playlist longer than a warm run reports what it left out — silently
  // warming the first 200 of 400 would look like the rest simply failed.
  const warmPlaylist = async (playlist) => {
    const r = await post('/spotify-playlist', { playlist });
    if (r.ok && r.playlist && r.playlist.truncated) {
      toast.info(
        `"${r.playlist.name}" has ${r.playlist.total} tracks — warming the first ${r.warm.total}`
      );
    }
  };

  return (
    <div class="card warm-card">
      <div class="card-title">
        Set-list warming
        <button class="btn sm warm-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Open'}
        </button>
      </div>

      {(warm.running || hasList) && <Progress warm={warm} />}

      {open && (
        <>
          <p class="warm-help">
            Live prefetch only looks a few tracks down the queue, and only once something is
            playing. Paste tonight&rsquo;s set list — one <code>Artist - Title</code> per line — or
            point it at a Spotify playlist, and every track is analysed and cached before doors
            open.
          </p>

          <SpotifyPlaylist
            ready={spotifyReady}
            canReadPrivate={canReadPrivate}
            running={warm.running}
            onWarm={warmPlaylist}
          />

          <textarea
            class="warm-input"
            rows="6"
            placeholder={'Daft Punk - Around the World\nJustice - Genesis\n…'}
            value={text}
            onInput={(e) => setText(e.target.value)}
            disabled={warm.running}
          />

          <div class="warm-actions">
            <button
              class="btn active"
              disabled={warm.running || !text.trim()}
              onClick={() => post('', { text })}
            >Warm this list</button>

            <button
              class="btn"
              disabled={warm.running || !spotifyReady}
              title={spotifyReady ? 'Warm everything Spotify has queued' : 'Connect Spotify first'}
              onClick={() => post('/spotify-queue', {})}
            >Warm the Spotify queue</button>

            {warm.running && (
              <button class="btn danger" onClick={() => post('')}>Stop</button>
            )}
            {!warm.running && hasList && (
              <button class="btn" onClick={() => post('')}>Clear</button>
            )}
          </div>

          {hasList && (
            <div class="warm-list">
              {warm.tracks.map((t) => (
                <div key={t.cacheKey} class={`warm-row ${t.status}`}>
                  <span class="warm-row-name">{t.query}</span>
                  <span class="warm-row-status" title={t.message}>
                    {STATUS_LABEL[t.status] || t.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
