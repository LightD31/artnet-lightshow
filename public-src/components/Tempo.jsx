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

  const bpm = s.bpm || 120;
  const division = s.beatDivision || 1;
  const periodMs = (60_000 / bpm) / division;
  const pulse = !!s.running && !s.masterBlackout && bpm > 0;

  return (
    <div class="card">
      <div class="card-title">Tempo</div>

      <div
        class={`bpm-display ${pulse ? 'pulse' : ''}`}
        style={{ '--bpm-period': `${periodMs.toFixed(0)}ms` }}
      >
        {s.bpm ?? '—'}
      </div>
      <div class="bpm-label">BEATS PER MINUTE</div>

      <div class="bpm-controls">
        <div class="bpm-adj">
          <button class="btn icon" onClick={() => send({ bpm: (s.bpm || 120) - 1 })} title="Slower">−</button>
          <button class="btn icon" onClick={() => send({ bpm: (s.bpm || 120) + 1 })} title="Faster">+</button>
        </div>
        <div class="bpm-adj" style={{ justifyContent: 'flex-end' }}>
          <input
            class="bpm-input"
            type="number"
            min="20" max="300"
            value={s.bpm ?? 120}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v >= 20 && v <= 300) send({ bpm: v });
            }}
          />
        </div>
      </div>

      <button class="tap-btn" onClick={emitTap} title="Tap tempo (Space)">TAP</button>

      <div class="beat-div-btns">
        <span class="beat-div-label">Beat</span>
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
