import { useEffect } from 'preact/hooks';
import { stateSig, send, emitTap } from '../state.js';

const DIVISIONS = [1, 2, 4, 8];

export function CommandBar() {
  const s = stateSig.value;
  const bpm = s.bpm || 120;
  const division = s.beatDivision || 1;
  const periodMs = (60_000 / bpm) / division;
  const pulse = !!s.running && !s.masterBlackout && bpm > 0;

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

  const dim = s.masterDimmer ?? 255;
  const masterPct = Math.round((dim / 255) * 100);
  const effects = s.energyEffects || [];

  const activate = (id) => (e) => { e.preventDefault(); send({ energyOverride: id }); };
  const deactivate = (id) => () => { if (s.energyOverride === id) send({ energyOverride: null }); };

  return (
    <div class="command-bar">
      {/* Tempo block */}
      <div class="cb-block cb-tempo">
        <div
          class={`cb-bpm ${pulse ? 'pulse' : ''}`}
          style={{ '--bpm-period': `${periodMs.toFixed(0)}ms` }}
        >
          <span class="cb-bpm-num">{s.bpm ?? '—'}</span>
          <span class="cb-bpm-label">BPM</span>
        </div>
        <button class="cb-tap" onClick={emitTap} title="Tap tempo (Space)">TAP</button>
        <div class="cb-bpm-controls">
          <button class="btn icon sm" onClick={() => send({ bpm: bpm - 1 })}>−</button>
          <button class="btn icon sm" onClick={() => send({ bpm: bpm + 1 })}>+</button>
          <div class="cb-divs">
            {DIVISIONS.map((d) => (
              <button
                key={d}
                class={`btn sm ${s.beatDivision === d ? 'active' : ''}`}
                onClick={() => send({ beatDivision: d })}
                title={`Beat division 1/${d}`}
              >{d === 1 ? '1' : `1/${d}`}</button>
            ))}
          </div>
        </div>
      </div>

      <div class="cb-divider" />

      {/* Transport */}
      <div class="cb-block cb-transport">
        <button
          class={`cb-play ${s.running ? 'active' : ''}`}
          onClick={() => send({ running: !s.running })}
          title={s.running ? 'Stop' : 'Play'}
        >{s.running ? '■' : '▶'}</button>

        <button
          class={`cb-blackout ${s.masterBlackout ? 'active' : ''}`}
          onClick={() => send({ masterBlackout: !s.masterBlackout })}
          title="Master blackout"
        >
          <span class="cb-blackout-dot" />
          <span>BLACKOUT</span>
        </button>

        <div class="cb-master">
          <span class="cb-master-label">MASTER</span>
          <input
            type="range" min="0" max="255"
            value={dim}
            onInput={(e) => send({ masterDimmer: parseInt(e.target.value, 10) })}
          />
          <span class="cb-master-val">{masterPct}%</span>
        </div>
      </div>

      <div class="cb-divider" />

      {/* Energy panic strip */}
      <div class="cb-block cb-energy">
        <span class="cb-energy-label">ENERGY</span>
        <div class="cb-energy-grid">
          {effects.map((eff) => (
            <button
              key={eff.id}
              class={`cb-energy-btn ${s.energyOverride === eff.id ? 'active' : ''}`}
              onMouseDown={activate(eff.id)}
              onMouseUp={deactivate(eff.id)}
              onMouseLeave={deactivate(eff.id)}
              onTouchStart={activate(eff.id)}
              onTouchEnd={deactivate(eff.id)}
              onTouchCancel={deactivate(eff.id)}
              title={`${eff.name} — ${eff.desc} (hold)`}
            >
              <span class="cb-energy-name">{eff.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
