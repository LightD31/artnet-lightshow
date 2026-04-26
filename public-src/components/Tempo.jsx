import { useEffect } from 'preact/hooks';
import { stateSig, send, emitTap } from '../state.js';

const DIVISIONS = [1, 2, 4, 8];

export function Tempo() {
  const s = stateSig.value;

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
      e.preventDefault();
      emitTap();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="card">
      <div class="card-title">Tempo</div>

      <div class="bpm-display">{s.bpm ?? '—'}</div>
      <div class="bpm-label">BPM</div>

      <div class="bpm-controls">
        <div class="bpm-adj">
          <button class="btn icon" onClick={() => send({ bpm: (s.bpm || 120) - 1 })}>−</button>
          <button class="btn icon" onClick={() => send({ bpm: (s.bpm || 120) + 1 })}>+</button>
          <label>BPM</label>
        </div>
        <div class="bpm-adj">
          <input
            type="number"
            min="20" max="300"
            value={s.bpm ?? 120}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v >= 20 && v <= 300) send({ bpm: v });
            }}
            style={{ width: '62px', background: 'var(--surface)', border: '1px solid var(--border)',
                     color: 'var(--text)', borderRadius: '6px', padding: '4px 6px',
                     fontSize: '14px', fontFamily: 'monospace' }}
          />
        </div>
      </div>

      <button class="tap-btn" onClick={emitTap}>TAP</button>

      <div class="beat-div-btns">
        <span style={{ fontSize: '11px', color: 'var(--muted)', marginRight: '4px', lineHeight: '26px' }}>Beat:</span>
        {DIVISIONS.map((d) => (
          <button
            key={d}
            class={`btn sm ${s.beatDivision === d ? 'active' : ''}`}
            onClick={() => send({ beatDivision: d })}
          >{d === 1 ? '1/1' : `1/${d}`}</button>
        ))}
      </div>
    </div>
  );
}
