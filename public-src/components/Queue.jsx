import { send, pick } from '../state.js';


const DEPTHS = [1, 2, 3, 4, 5];

const STATUS_LABEL = {
  idle: 'idle',
  prefetching: 'analysing…',
  ready: 'ready',
  queued: 'queued',
  error: 'failed',
  empty: 'queue empty',
  unavailable: 'unavailable',
};

// Use a connected source as fallback so empty queues can still explain their state.
export function activeQueue(s) {
  const spotify = Array.isArray(s.spotifyPrefetch) ? s.spotifyPrefetch : [];
  const deezer = Array.isArray(s.deezerPrefetch) ? s.deezerPrefetch : [];

  if (spotify.some((slot) => slot.track)) return { source: 'Spotify', slots: spotify };
  if (deezer.some((slot) => slot.track)) return { source: 'Deezer', slots: deezer };
  if (s.spotify && s.spotify.authenticated) return { source: 'Spotify', slots: spotify };
  if (s.deezer && s.deezer.authenticated) return { source: 'Deezer', slots: deezer };
  return null;
}

function Row({ slot, position }) {
  const track = slot.track || {};
  const status = slot.status || 'idle';
  return (
    <div class={`queue-row queue-${status}`}>
      <span class="queue-pos">{position}</span>
      <span class="queue-track">
        <span class="queue-name">{track.name || '—'}</span>
        {track.artist && <span class="queue-artist">{track.artist}</span>}
      </span>
      <span class="queue-status" title={slot.message || ''}>
        {STATUS_LABEL[status] || status}
      </span>
    </div>
  );
}

export function Queue() {
  const s = pick(['autoPrefetchDepth', 'deezer', 'deezerPrefetch', 'spotify', 'spotifyPrefetch']);
  const queue = activeQueue(s);
  if (!queue) return null;

  const depth = Math.max(1, Math.min(5, s.autoPrefetchDepth || 1));
  const slots = queue.slots.filter((slot) => slot.track);
  // Empty slots carry reasons, so show them instead of a blank panel.
  const reason = queue.slots.find((slot) => !slot.track);

  return (
    <section class="panel queue-panel">
      <header class="panel-head">
        <h2 class="panel-title">Up next</h2>
        <span class="panel-tag">{queue.source}</span>
        <div class="queue-depth">
          <span class="queue-depth-label" id="queue-depth-label">Analyse ahead</span>
          <div class="segmented" role="group" aria-labelledby="queue-depth-label">
            {DEPTHS.map((n) => (
              <button
                key={n}
                type="button"
                class={`segmented-btn ${depth === n ? 'active' : ''}`}
                aria-pressed={depth === n}
                onClick={() => send({ autoPrefetchDepth: n })}
                title={`Analyse the next ${n} track${n === 1 ? '' : 's'} in the background`}
              >{n}</button>
            ))}
          </div>
        </div>
      </header>

      {slots.length > 0 ? (
        <div class="queue-list">
          {slots.map((slot, i) => (
            <Row key={slot.cacheKey || i} slot={slot} position={i + 1} />
          ))}
        </div>
      ) : (
        <p class="panel-empty">
          {reason && reason.message
            ? reason.message
            : `Nothing queued on ${queue.source}. Whatever plays next is analysed when it starts.`}
        </p>
      )}
    </section>
  );
}
