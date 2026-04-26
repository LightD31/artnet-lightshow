import { stateSig, send } from '../state.js';

export function Strobe() {
  const s = stateSig.value;
  if (s.pattern !== 'strobe') return null;

  return (
    <div class="card">
      <div class="card-title">Strobe</div>
      <div class="slider-row">
        <label>Function</label>
        <select
          value={s.strobeFunction || 'standard'}
          onChange={(e) => send({ strobeFunction: e.target.value })}
          style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)',
                   color: 'var(--text)', borderRadius: '6px', padding: '5px 8px',
                   fontSize: '12px', fontFamily: 'inherit' }}
        >
          {(s.strobeFunctions || []).map((fn) => (
            <option key={fn.id} value={fn.id} title={fn.desc}>{fn.name}</option>
          ))}
        </select>
      </div>
      <div class="slider-row" style={{ marginBottom: 0 }}>
        <label>Speed</label>
        <input
          type="range" min="0" max="255"
          value={s.strobeSpeed ?? 0}
          onInput={(e) => send({ strobeSpeed: parseInt(e.target.value, 10) })}
        />
        <span class="val">{s.strobeSpeed ?? 0}</span>
      </div>
    </div>
  );
}
