import { useState } from 'preact/hooks';
import { stateSig } from '../state.js';

// Progress rides the state broadcast, so this component only ever posts.
const post = (path, body) => fetch(`/api/warm${path}`, {
  method: body === undefined ? 'DELETE' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then((r) => r.json()).catch((err) => ({ ok: false, error: err.message }));

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

export function Warm() {
  const s = stateSig.value;
  const warm = s.warm || { running: false, total: 0, done: 0, ready: 0, failed: 0, tracks: [] };
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const spotifyReady = !!(s.spotify && s.spotify.authenticated);

  const start = async (body) => {
    setError('');
    const res = body ? await post('', body) : await post('/spotify-queue', {});
    if (!res.ok) setError(res.error || 'Could not start warming');
  };

  const hasList = warm.tracks && warm.tracks.length > 0;

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
            playing. Paste tonight&rsquo;s set list — one <code>Artist - Title</code> per line — and
            every track is analysed and cached before doors open.
          </p>

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
              onClick={() => start({ text })}
            >Warm this list</button>

            <button
              class="btn"
              disabled={warm.running || !spotifyReady}
              title={spotifyReady ? 'Warm everything Spotify has queued' : 'Connect Spotify first'}
              onClick={() => start(null)}
            >Warm the Spotify queue</button>

            {warm.running && (
              <button class="btn danger" onClick={() => post('')}>Stop</button>
            )}
            {!warm.running && hasList && (
              <button class="btn" onClick={() => post('')}>Clear</button>
            )}
          </div>

          {error && <div class="warm-error">{error}</div>}

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
