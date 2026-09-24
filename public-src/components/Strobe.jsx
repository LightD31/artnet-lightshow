import { send, pick } from '../state.js';
import { useDraft } from '../draft.js';

export function Strobe() {
  const s = pick(['pattern', 'strobeFunction', 'strobeFunctions', 'strobeSpeed']);
  const [speed, onSpeed, commitSpeed] = useDraft(s.strobeSpeed ?? 0, (v) => send({ strobeSpeed: v }));
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
          aria-label="Strobe speed"
          value={speed}
          onInput={(e) => onSpeed(parseInt(e.target.value, 10))}
          onChange={(e) => commitSpeed(parseInt(e.target.value, 10))}
        />
        <span class="val">{speed}</span>
      </div>
    </div>
  );
}
