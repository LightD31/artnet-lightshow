import { stateSig, send } from '../state.js';

export function Transport() {
  const s = stateSig.value;
  const dim = s.masterDimmer ?? 255;
  const pct = Math.round((dim / 255) * 100);

  return (
    <div class="card">
      <div class="card-title">Transport</div>
      <div class="transport">
        <button
          class={`btn ${s.running ? 'active' : ''}`}
          onClick={() => send({ running: true })}
          title="Play"
        >
          <span class="icon-glyph">▶</span> Play
        </button>
        <button
          class={`btn ${!s.running ? 'active' : ''}`}
          onClick={() => send({ running: false })}
          title="Stop"
        >
          <span class="icon-glyph">■</span> Stop
        </button>
      </div>
      <div style={{ marginTop: '8px' }}>
        <button
          class={`btn danger block ${s.masterBlackout ? 'active' : ''}`}
          onClick={() => send({ masterBlackout: !s.masterBlackout })}
          style={{ padding: '12px', fontSize: '13px', fontWeight: 800, letterSpacing: '0.18em' }}
          title="Master blackout (kills all output)"
        >
          {s.masterBlackout ? '◉ BLACKOUT ACTIVE' : '○ BLACKOUT'}
        </button>
      </div>
      <div class="slider-row" style={{ marginTop: '14px', marginBottom: 0 }}>
        <label>Master {pct}%</label>
        <input
          type="range" min="0" max="255"
          value={dim}
          onInput={(e) => send({ masterDimmer: parseInt(e.target.value, 10) })}
        />
        <span class="val">{dim}</span>
      </div>
    </div>
  );
}
