import { stateSig, send } from '../state.js';

// Map pattern ids to a unicode glyph. Falls back to a dot.
const PATTERN_ICONS = {
  solid:         '●',
  chase:         '→',
  'chase-rev':   '←',
  'ping-pong':   '⇄',
  strobe:        '⚡',
  fade:          '◐',
  'color-cycle': '◌',
  rainbow:       '✦',
  twinkle:       '✶',
  split:         '◧',
  sparkle:       '✧',
  wave:          '∿',
  'stack-up':    '⇡',
  'random-flash':'⚹',
  runner:        '➤',
  pairs:         '⋮⋮',
  hit:           '✖',
  'alt-halves':  '◨',
  'split-3':     '⫶',
  'chase-3':     '➰',
  'alt-thirds':  '☷',
  'split-4':     '⊞',
  'chase-4':     '⟳',
  'alt-quarters':'⊠',
  'pairs-4':     '⫴',
};

function iconFor(id) {
  return PATTERN_ICONS[id] || '·';
}

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
            title={p.desc || p.name}
          >
            <span class="icon">{iconFor(p.id)}</span>
            <span class="body">
              <span class="name">{p.name}</span>
              <span class="desc">{p.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
