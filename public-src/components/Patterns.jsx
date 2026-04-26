import { stateSig, send } from '../state.js';

export function Patterns() {
  const s = stateSig.value;
  const patterns = s.patterns || [];
  return (
    <div class="card">
      <div class="card-title">Pattern</div>
      <div class="pattern-grid">
        {patterns.map((p) => (
          <button
            key={p.id}
            class={`pattern-btn ${s.pattern === p.id ? 'active' : ''}`}
            onClick={() => send({ pattern: p.id })}
          >
            <span class="name">{p.name}</span>
            <span class="desc">{p.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
