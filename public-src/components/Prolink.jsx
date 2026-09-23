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

  const followed = p.followed || null;
  const decks = Array.isArray(p.loadedTracks) ? p.loadedTracks : [];

  const trackText = (() => {
    if (p.track && (p.track.title || p.track.artist)) {
      return `${p.track.title || '?'} — ${p.track.artist || '?'}`;
    }
    if (followed && followed.trackId) return 'Loading metadata…';
    return '—';
  })();

  return (
    <div class="card">
      <div class="card-title">PRO DJ LINK</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <div class={`status-dot ${p.connected ? 'connected' : ''}`} />
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600 }}>{statusText(p)}</span>
        <button
          class={`btn sm ${p.enabled ? 'active' : ''}`}
          style={{ marginLeft: 'auto' }}
          onClick={() => send({ prolinkEnabled: !p.enabled })}
        >{p.enabled ? 'Disable' : 'Enable'}</button>
      </div>

      <div class="prolink-info">
        <div>{p.peers} device{p.peers !== 1 ? 's' : ''}</div>
        <div>
          {followed
            ? <>Following <strong>CDJ-{followed.deviceId}</strong> · {followed.bpm ? followed.bpm.toFixed(1) : '—'} BPM · beat {followed.beatInMeasure || '–'}/4{followed.absolute ? ' · exact position' : ''}</>
            : 'No deck playing'}
        </div>
        <div>{trackText}</div>
      </div>

      {decks.length > 0 && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {decks.map(({ playerId, track, playing, onAir, master, followed: isFollowed }) => {
            const title = track && track.title ? track.title : track ? `Track ${track.trackId}` : '…';
            const artist = track && track.artist ? track.artist : '';
            const flags = [master && 'MASTER', onAir && 'ON AIR', !playing && 'stopped'].filter(Boolean).join(' · ');
            return (
              <div
                key={playerId}
                title={artist ? `${artist} — ${title}` : title}
                style={{
                  fontSize: '11px',
                  color: isFollowed ? 'var(--accent-3)' : 'var(--muted)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ opacity: 0.6 }}>CDJ-{playerId}</span>{' '}
                {isFollowed ? '▶ ' : ''}
                <strong style={{ fontWeight: 600 }}>{title}</strong>
                {artist && <span style={{ opacity: 0.7 }}> — {artist}</span>}
                {flags && <span style={{ opacity: 0.6 }}> · {flags}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
