import { useEffect, useRef } from 'preact/hooks';
import { stateSig, send } from '../state.js';
import { AnalysisStats } from './AnalysisStats.jsx';
import { AutoTimeline } from './AutoTimeline.jsx';

const NEXT_LABELS = {
  idle: 'Idle',
  prefetching: 'Prefetching',
  ready: 'Ready',
  queued: 'Queued',
  error: 'Error',
  empty: 'Queue empty',
  unavailable: 'Unavailable',
};

function statusMessage(status) {
  switch (status) {
    case 'downloading': return 'Downloading full audio via yt-dlp…';
    case 'analyzing':   return 'Analyzing audio with Essentia…';
    case 'playing':     return 'Auto show running';
    case 'ready':       return 'Analysis complete — ready to start';
    default:            return '';
  }
}

export function AutoMode() {
  const s = stateSig.value;
  const sp = s.spotify;
  const np = s.nowPlaying || {};
  const as = s.autoShow;
  const next = s.spotifyNext;
  const prefetchSlots = Array.isArray(s.spotifyPrefetch) ? s.spotifyPrefetch : [];
  const prefetchDepth = Math.max(1, Math.min(5, s.autoPrefetchDepth || 1));

  const pendingStartRef = useRef(false);
  useEffect(() => {
    if (pendingStartRef.current && as && as.status === 'ready') {
      pendingStartRef.current = false;
      fetch('/api/auto/start', { method: 'POST' });
    }
  }, [as && as.status]);

  if (!sp || !as) return null;

  const spotifyDot = sp.authenticated ? 'connected' : '';
  const spotifyText = sp.authenticated
    ? 'Spotify connected'
    : sp.configured
      ? 'Spotify not connected'
      : 'Spotify not configured';

  const busy = as.status === 'downloading' || as.status === 'analyzing';

  const analyzeAndStart = () => {
    if (as.status === 'playing') return;
    if (as.status === 'ready')   { fetch('/api/auto/start', { method: 'POST' }); return; }

    const source = s.autoSource || 'auto';
    const spotifyReady = sp.authenticated;
    const nowPlayingReady = s.nowPlaying && s.nowPlaying.authenticated;
    const prolinkReady = s.prolink && s.prolink.connected && s.prolink.track && s.prolink.track.title;
    const useSpotify    = source === 'spotify'    || (source === 'auto' && spotifyReady);
    const useNowPlaying = source === 'nowplaying' || (source === 'auto' && !spotifyReady && nowPlayingReady);
    const useProlink    = source === 'prolink'    || (source === 'auto' && !spotifyReady && !nowPlayingReady && prolinkReady);

    const triggerAnalyze = (endpoint) => {
      pendingStartRef.current = true;
      fetch(endpoint, { method: 'POST' })
        .then((r) => r.json())
        .then((d) => { if (!d.ok) pendingStartRef.current = false; })
        .catch(() => { pendingStartRef.current = false; });
    };

    if (useSpotify)         triggerAnalyze('/api/auto/analyze-spotify');
    else if (useNowPlaying) triggerAnalyze('/api/auto/analyze-nowplaying');
    else if (useProlink)    triggerAnalyze('/api/auto/analyze-prolink');
    else fetch('/api/auto/start', { method: 'POST' });
  };

  const showNext = next && next.track;
  const showNextEmpty = !showNext && sp.authenticated;
  const fallbackStatus = next && next.status ? next.status : 'idle';

  return (
    <>
      {/* Compact 2-column control card */}
      <div class="card auto-card-grid" id="auto-card">
        <div class="auto-card-left">
          <div class="auto-controls-row">
            <span class={`auto-badge auto-badge-${as.status}`} style={{ marginLeft: 0 }}>{(as.status || '').toUpperCase()}</span>
            <select
              class="auto-select"
              value={s.autoSource || 'auto'}
              onChange={(e) => send({ autoSource: e.target.value })}
              title="Source"
            >
              <option value="auto">Auto-detect</option>
              <option value="prolink">PRO DJ LINK</option>
              <option value="spotify">Spotify</option>
              <option value="nowplaying">Now Playing (OS)</option>
              <option value="timer">Standalone timer</option>
            </select>
            <div class="palette-size-toggle" role="group" aria-label="Palette size" title="Palette size">
              {[2, 3, 4].map((sz) => (
                <button
                  key={sz}
                  type="button"
                  class={`btn palette-size-btn ${(as.paletteSize || 4) === sz ? 'active' : ''}`}
                  onClick={() => send({ autoPaletteSize: sz })}
                >{sz}</button>
              ))}
            </div>
            <div class="auto-prefetch" title="How many upcoming Spotify tracks to prefetch in the background">
              <label>QUEUE</label>
              <input
                type="number" min="1" max="5" step="1"
                value={prefetchDepth}
                onInput={(e) => {
                  const v = Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1));
                  send({ autoPrefetchDepth: v });
                }}
              />
            </div>
            <div class="auto-intensity">
              <label title="Energy intensity">INT</label>
              <input
                type="range" min="0" max="100"
                value={as.intensity ?? 50}
                onInput={(e) => send({ autoIntensity: Number(e.target.value) })}
              />
              <span class="val">{as.intensity ?? 50}</span>
            </div>
            <div class="auto-actions">
              <button
                class="btn active"
                disabled={as.status === 'playing' || busy}
                onClick={analyzeAndStart}
              >{busy ? '⟳' : '▶'} {busy ? 'Analyzing' : 'Start'}</button>
              <button
                class="btn"
                disabled={as.status !== 'playing'}
                onClick={() => { pendingStartRef.current = false; fetch('/api/auto/stop', { method: 'POST' }); }}
              >■</button>
            </div>
          </div>

          {as.track && (
            <div class="auto-now-playing">
              {as.track.albumArt && <img class="auto-album-art" src={as.track.albumArt} alt="" />}
              <div class="auto-track-info">
                <div class="auto-track-name">{as.track.name}</div>
                <div class="auto-track-artist">{as.track.artist}</div>
              </div>
            </div>
          )}

          <div class="auto-status-row">
            <div class={`status-dot ${spotifyDot}`} />
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{spotifyText}</span>
            {!sp.authenticated && (
              <button
                class="btn sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => window.open('/auth/spotify', '_blank', 'width=500,height=700')}
              >Connect</button>
            )}
            {sp.authenticated && (
              <button
                class="btn sm danger"
                style={{ marginLeft: 'auto' }}
                onClick={() => fetch('/api/spotify/disconnect', { method: 'POST' })}
              >Disconnect</button>
            )}
          </div>

          <div class="auto-status-row">
            <div class={`status-dot ${np.authenticated ? 'connected' : ''}`} />
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {np.authenticated
                ? `Now playing: ${np.artist ? `${np.artist} — ` : ''}${np.name || 'unknown'}`
                : 'No media detected (OS now-playing)'}
            </span>
          </div>

          {sp.authenticated && (
            <div class="auto-next-list">
              {prefetchSlots.length === 0 || !prefetchSlots[0].track ? (
                <div class="auto-next-song">
                  <div class="auto-next-label">Up next</div>
                  <div class="auto-next-track">-</div>
                  <div class="auto-next-meta">
                    <span class="auto-next-artist"></span>
                    <span class={`auto-next-status ${fallbackStatus}`}>
                      {NEXT_LABELS[fallbackStatus] || 'Idle'}
                    </span>
                  </div>
                </div>
              ) : (
                prefetchSlots.map((slot, i) => (
                  <div key={slot.cacheKey || i} class={`auto-next-song ${i > 0 ? 'auto-next-song-sub' : ''}`}>
                    <div class="auto-next-label">{i === 0 ? 'Up next' : `+${i}`}</div>
                    <div class="auto-next-track">{slot.track?.name || '-'}</div>
                    <div class="auto-next-meta">
                      <span class="auto-next-artist">{slot.track?.artist || ''}</span>
                      <span
                        class={`auto-next-status ${slot.status || 'idle'}`}
                        title={slot.message || ''}
                      >
                        {NEXT_LABELS[slot.status] || slot.status || 'Idle'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {statusMessage(as.status) && (
            <div class="auto-status-message">{statusMessage(as.status)}</div>
          )}
        </div>

        <div class="auto-card-right">
          {as.analysis ? (
            <AnalysisStats as={as} colorPresets={s.colorPresets} />
          ) : (
            <div class="auto-empty">Run an auto-show to see analysis here.</div>
          )}
          <div class="auto-timeline-inline">
            <AutoTimeline />
          </div>
        </div>
      </div>
    </>
  );
}
