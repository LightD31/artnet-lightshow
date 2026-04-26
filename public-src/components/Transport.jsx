import { stateSig, send } from '../state.js';

export function Transport() {
  const s = stateSig.value;
  return (
    <div class="card">
      <div class="card-title">Transport</div>
      <div class="transport">
        <button class={`btn ${s.running ? 'active' : ''}`} onClick={() => send({ running: true })}>▶ Play</button>
        <button class={`btn ${!s.running ? 'active' : ''}`} onClick={() => send({ running: false })}>■ Stop</button>
        <button
          class={`btn danger ${s.masterBlackout ? 'active' : ''}`}
          onClick={() => send({ masterBlackout: !s.masterBlackout })}
        >BLACKOUT</button>
      </div>
      <div class="slider-row" style={{ marginTop: '12px', marginBottom: 0 }}>
        <label>Master</label>
        <input
          type="range" min="0" max="255"
          value={s.masterDimmer ?? 255}
          onInput={(e) => send({ masterDimmer: parseInt(e.target.value, 10) })}
        />
        <span class="val">{s.masterDimmer ?? 255}</span>
      </div>
    </div>
  );
}
