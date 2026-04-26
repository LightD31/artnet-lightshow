import { stateSig, send } from '../state.js';

function statusText(p) {
  if (p.connected && p.stale) return 'Stale (no packets)';
  if (p.connected)             return 'Connected';
  if (p.enabled)               return 'Connecting…';
  if (p.lastError)             return `Error: ${p.lastError}`;
  return 'Disabled';
}

export function Prolink() {
  const s = stateSig.value;
  const p = s.prolink;
  if (!p) return null;

  const masterTrackId = p.master ? p.master.trackId : null;
  const tracks = Array.isArray(p.loadedTracks) ? p.loadedTracks : [];

  const trackText = (() => {
    if (p.track && (p.track.title || p.track.artist)) {
      return `${p.track.title || '?'} — ${p.track.artist || '?'}`;
    }
    if (p.master && p.master.trackId) return 'Loading metadata…';
    return '—';
  })();

  return (
    <div class="card">
      <div class="card-title">PRO DJ LINK</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <div class={`status-dot ${p.connected ? 'connected' : ''}`} />
        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{statusText(p)}</span>
        <button
          class={`btn sm ${p.enabled ? 'active' : ''}`}
          style={{ marginLeft: 'auto' }}
          onClick={() => send({ prolinkEnabled: !p.enabled })}
        >{p.enabled ? 'Disable' : 'Enable'}</button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
        {p.peers} device{p.peers !== 1 ? 's' : ''}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>
        {p.master
          ? `Master: CDJ-${p.master.deviceId} · ${p.master.bpm ? p.master.bpm.toFixed(1) : '—'} BPM · beat ${p.master.beatInMeasure || '–'}/4`
          : 'No master'}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{trackText}</div>

      {tracks.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {tracks.map(({ playerId, track }) => {
            const isMaster = track && masterTrackId && track.trackId === masterTrackId;
            const title = track && track.title ? track.title : track ? `Track ${track.trackId}` : '…';
            const artist = track && track.artist ? track.artist : '';
            return (
              <div
                key={playerId}
                title={artist ? `${artist} — ${title}` : title}
                style={{
                  fontSize: '11px',
                  color: isMaster ? 'var(--accent, #7c6)' : 'var(--muted)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ opacity: 0.6 }}>CDJ-{playerId}</span>{' '}
                {isMaster ? '▶ ' : ''}
                <strong style={{ fontWeight: 500 }}>{title}</strong>
                {artist && <span style={{ opacity: 0.7 }}> — {artist}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
