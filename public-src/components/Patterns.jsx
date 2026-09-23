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
  sections:      '▥',
  ensemble:      '◉',
  ribbon:        '〰',
  gradient:      '▤',
  comet:         '☄',
  burst:         '◎',
  plasma:        '≋',
  meter:         '▮',
};

// How a pixel effect is laid over the cells of the rig's LED bars.
const PIXEL_MAPS = [
  { id: 'stage', name: 'Across stage', desc: 'One picture across every bar, as they stand on the stage plot' },
  { id: 'bar', name: 'Per bar', desc: 'Every bar draws the whole picture along itself' },
  { id: 'mirror', name: 'Mirrored', desc: 'The picture mirrored about the centre of the stage' },
];

/** Does the patch have a fixture that is more than one light? */
function hasBars(s) {
  const profiles = s.profiles || {};
  return (s.fixtures || []).some((f) => {
    const cells = profiles[f.profileId] && profiles[f.profileId].cells;
    return Array.isArray(cells) && cells.length >= 2;
  });
}

function iconFor(id) {
  return PATTERN_ICONS[id] || '·';
}

function PatternButton({ p, active }) {
  return (
    <button
      class={`pattern-btn ${active ? 'active' : ''}`}
      onClick={() => send({ pattern: p.id })}
      title={p.desc || p.name}
    >
      <span class="icon">{iconFor(p.id)}</span>
      <span class="body">
        <span class="name">{p.name}</span>
        <span class="desc">{p.desc}</span>
      </span>
    </button>
  );
}

export function Patterns() {
  const s = stateSig.value;
  const patterns = s.patterns || [];
  const bars = hasBars(s);
  // The pixel effects are drawn for LED bars; on a rig of pars they still run,
  // as a handful of samples of the picture, so they stay available below.
  const lamp = patterns.filter((p) => !p.pixel);
  const pixel = patterns.filter((p) => p.pixel);
  return (
    <div class="card">
      <div class="card-title">Pattern</div>
      <div class="pattern-grid">
        {lamp.map((p) => <PatternButton key={p.id} p={p} active={s.pattern === p.id} />)}
      </div>
      {pixel.length > 0 && <>
        <div class="card-subtitle">{bars ? 'Pixel effects' : 'Pixel effects — drawn for LED bars'}</div>
        <div class="pattern-grid">
          {pixel.map((p) => <PatternButton key={p.id} p={p} active={s.pattern === p.id} />)}
        </div>
      </>}
      {bars && (
        <div class="pixel-map" role="group" aria-label="How pictures are laid over the bars">
          {PIXEL_MAPS.map((m) => (
            <button key={m.id} class={`btn sm ${(s.pixelMap || 'stage') === m.id ? 'active' : ''}`}
              aria-pressed={(s.pixelMap || 'stage') === m.id} title={m.desc}
              onClick={() => send({ pixelMap: m.id })}>{m.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

