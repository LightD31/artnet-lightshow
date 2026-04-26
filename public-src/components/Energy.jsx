import { stateSig, send } from '../state.js';

// Momentary triggers — hold to activate, release to clear.
export function Energy() {
  const s = stateSig.value;
  const effects = s.energyEffects || [];

  const activate = (id) => (e) => { e.preventDefault(); send({ energyOverride: id }); };
  const deactivate = (id) => () => { if (s.energyOverride === id) send({ energyOverride: null }); };

  return (
    <div class="card">
      <div class="card-title">Energy Override</div>
      <div class="energy-grid">
        {effects.map((eff) => (
          <button
            key={eff.id}
            class={`energy-btn ${s.energyOverride === eff.id ? 'active' : ''}`}
            onMouseDown={activate(eff.id)}
            onMouseUp={deactivate(eff.id)}
            onMouseLeave={deactivate(eff.id)}
            onTouchStart={activate(eff.id)}
            onTouchEnd={deactivate(eff.id)}
            onTouchCancel={deactivate(eff.id)}
          >
            <span class="name">{eff.name}</span>
            <span class="desc">{eff.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
