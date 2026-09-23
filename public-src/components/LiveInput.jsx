import { stateSig } from '../state.js';

function statusText(live) {
  if (live.listening) return 'Listening';
  if (live.running && live.error) return `Error: ${live.error}`;
  if (live.running) return 'Starting…';
  return 'Off';
}

/** The live input: what it hears, and whether it has found the beat. */
export function LiveInput() {
  const live = stateSig.value.live;
  if (!live) return null;
  // -60 dBFS reads as silence, 0 as full scale.
  const level = live.levelDb == null ? 0 : Math.max(0, Math.min(1, (live.levelDb + 60) / 60));
  return (
    <div class="card">
      <div class="card-title">Live Input</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <div class={`status-dot ${live.listening ? 'connected' : ''}`} />
        <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 600 }}>{statusText(live)}</span>
        <a class="btn sm" style={{ marginLeft: 'auto' }} href="/settings.html#music">Settings</a>
      </div>
      <div class="prolink-info">
        <div>
          {live.source === 'input' ? 'Input' : 'What this computer plays'}
          {live.device ? <> · <strong>{live.device}</strong></> : ''}
          {live.backend ? <span style={{ opacity: 0.6 }}> ({live.backend})</span> : ''}
        </div>
        <div>
          {live.listening
            ? <>{live.bpm ? `${live.bpm.toFixed(1)} BPM` : 'Finding the tempo…'} · {live.locked ? 'on the beat' : 'finding the beat…'}</>
            : '—'}
        </div>
      </div>
      <div
        role="meter"
        aria-label="Input level"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={live.levelDb == null ? -60 : live.levelDb}
        style={{ marginTop: '8px', height: '4px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden' }}
      >
        <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: 'var(--accent-3)' }} />
      </div>
    </div>
  );
}
