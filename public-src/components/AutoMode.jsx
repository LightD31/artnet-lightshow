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
  const as = s.autoShow;
  const next = s.spotifyNext;

  // Auto-start trigger when one-click "analyze + start" finishes its analysis.
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
    ? 'Connected'
    : sp.configured
      ? 'Not connected'
      : 'Not configured (set SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET)';

  const busy = as.status === 'downloading' || as.status === 'analyzing';

  const analyzeAndStart = () => {
    if (as.status === 'playing') return;
    if (as.status === 'ready')   { fetch('/api/auto/start', { method: 'POST' }); return; }

    const source = s.autoSource || 'auto';
    const spotifyReady = sp.authenticated;
    const prolinkReady = s.prolink && s.prolink.connected && s.prolink.track && s.prolink.track.title;
    const useSpotify = source === 'spotify' || (source === 'auto' && spotifyReady);
    const useProlink = source === 'prolink' || (source === 'auto' && !spotifyReady && prolinkReady);

    if (useSpotify) {
      pendingStartRef.current = true;
      fetch('/api/auto/analyze-spotify', { method: 'POST' })
        .then((r) => r.json())
        .then((d) => { if (!d.ok) pendingStartRef.current = false; })
        .catch(() => { pendingStartRef.current = false; });
    } else if (useProlink) {
      pendingStartRef.current = true;
      fetch('/api/auto/analyze-prolink', { method: 'POST' })
        .then((r) => r.json())
        .then((d) => { if (!d.ok) pendingStartRef.current = false; })
        .catch(() => { pendingStartRef.current = false; });
    } else {
      fetch('/api/auto/start', { method: 'POST' });
    }
  };

  const showNext = next && next.track;
  const showNextEmpty = !showNext && sp.authenticated;
  const fallbackStatus = next && next.status ? next.status : 'idle';

  return (
    <div class="card" id="auto-card">
      <div class="card-title">Auto Mode <span class={`auto-badge auto-badge-${as.status}`}>{(as.status || '').toUpperCase()}</span></div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '11px', color: 'var(--muted)' }}>Source:</label>
        <select
          value={s.autoSource || 'auto'}
          onChange={(e) => send({ autoSource: e.target.value })}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)',
                   color: 'var(--text)', borderRadius: '6px', padding: '4px 6px',
                   fontSize: '12px', fontFamily: 'inherit' }}
        >
          <option value="auto">Auto-detect</option>
          <option value="prolink">PRO DJ LINK</option>
          <option value="spotify">Spotify</option>
          <option value="timer">Standalone timer</option>
        </select>
        <label style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '4px' }}
               title="How many colours the locked palette uses">Palette:</label>
        <div class="palette-size-toggle" role="group" aria-label="Palette size">
          {[2, 3, 4].map((sz) => (
            <button
              key={sz}
              type="button"
              class={`btn palette-size-btn ${(as.paletteSize || 4) === sz ? 'active' : ''}`}
              onClick={() => send({ autoPaletteSize: sz })}
            >{sz}</button>
          ))}
        </div>
      </div>

      <div class="slider-row" style={{ marginBottom: '8px' }}>
        <label title="Energy intensity — scales accent density, drop effects, and beat-division escalation">Intensity</label>
        <input
          type="range" min="0" max="100"
          value={as.intensity ?? 50}
          onInput={(e) => send({ autoIntensity: Number(e.target.value) })}
        />
        <span class="val">{as.intensity ?? 50}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <div class={`status-dot ${spotifyDot}`} />
        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{spotifyText}</span>
        {!sp.authenticated && (
          <button
            class="btn sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => window.open('/auth/spotify', '_blank', 'width=500,height=700')}
          >Connect Spotify</button>
        )}
        {sp.authenticated && (
          <button
            class="btn sm danger"
            style={{ marginLeft: 'auto' }}
            onClick={() => fetch('/api/spotify/disconnect', { method: 'POST' })}
          >Disconnect</button>
        )}
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

      {(showNext || showNextEmpty) && (
        <div class="auto-next-song">
          <div class="auto-next-label">Next</div>
          <div class="auto-next-track">{showNext ? (next.track.name || '-') : '-'}</div>
          <div class="auto-next-meta">
            <span class="auto-next-artist">{showNext ? (next.track.artist || '') : ''}</span>
            <span
              class={`auto-next-status ${(showNext ? next.status : fallbackStatus) || 'idle'}`}
              title={(showNext && next.message) || (next && next.message) || ''}
            >
              {NEXT_LABELS[showNext ? next.status : fallbackStatus] || (showNext ? next.status : 'Idle')}
            </span>
          </div>
        </div>
      )}

      {as.analysis && (
        <div class="auto-analysis">
          <AnalysisStats as={as} colorPresets={s.colorPresets} />
        </div>
      )}

      <AutoTimeline />

      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '8px' }}>
        {statusMessage(as.status)}
      </div>

      <div class="auto-transport" style={{ marginTop: '10px', display: 'flex', gap: '6px' }}>
        <button
          class="btn active"
          disabled={as.status === 'playing' || busy}
          onClick={analyzeAndStart}
        >{busy ? '… Analyzing' : '▶ Start Auto Show'}</button>
        <button
          class="btn"
          disabled={as.status !== 'playing'}
          onClick={() => { pendingStartRef.current = false; fetch('/api/auto/stop', { method: 'POST' }); }}
        >■ Stop</button>
      </div>
    </div>
  );
}
