import { send, pick } from '../state.js';

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
  drums:         '◍',
  stems:         '☰',
  rise:          '▲',
  impact:        '✺',
};

// How a pattern is laid over the rig. Per bar needs bars; the other two
// order a rig of pars as well.
const PIXEL_MAPS = [
  { id: 'stage', name: 'Across stage', desc: 'One picture across the rig, as it stands on the stage plot' },
  { id: 'bar', name: 'Per bar', desc: 'Every bar draws the whole picture along itself', bars: true },
  { id: 'mirror', name: 'Mirrored', desc: 'Mirrored about the centre of the stage: a chase runs from the middle out to both ends at once' },
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

function PatternButton({ p, active, onBars }) {
  return (
    <button
      class={`pattern-btn ${active ? 'active' : ''} ${onBars ? 'on-bars' : ''}`}
      onClick={() => send({ pattern: p.id })}
      title={p.desc || p.name}
    >
      <span class="icon">{iconFor(p.id)}</span>
      <span class="body">
        <span class="name">{p.name}{onBars && <span class="layer-tag"> · on the bars</span>}</span>
        <span class="desc">{p.desc}</span>
      </span>
    </button>
  );
}

export function Patterns() {
  const s = pick(['pattern', 'patterns', 'pixelMap', 'pixelPattern', 'fixtures', 'profiles']);
  const patterns = s.patterns || [];
  const bars = hasBars(s);
  // The pixel effects are drawn for LED bars; on a rig of pars they still run,
  // as a handful of samples of the picture, so they stay available below.
  const lamp = patterns.filter((p) => !p.pixel);
  const pixel = patterns.filter((p) => p.pixel);
  // The auto show gives the pars and the bars a look each: the pars the
  // colour, the bars the movement. Both are marked; a pattern picked here
  // runs on the whole rig again.
  const onBars = bars && s.pixelPattern ? s.pixelPattern : null;
  const barsLabel = onBars && (patterns.find((p) => p.id === onBars)?.name || onBars);
  // Along each bar is across the stage on a rig without bars.
  const map = !bars && s.pixelMap === 'bar' ? 'stage' : (s.pixelMap || 'stage');
  return (
    <div class="card">
      <div class="card-title">Pattern</div>
      {onBars && (
        <div class="card-subtitle" role="status">
          Pars on {patterns.find((p) => p.id === s.pattern)?.name || s.pattern}, bars on {barsLabel}
        </div>
      )}
      <div class="pattern-grid">
        {lamp.map((p) => <PatternButton key={p.id} p={p} active={s.pattern === p.id} onBars={onBars === p.id} />)}
      </div>
      {pixel.length > 0 && <>
        <div class="card-subtitle">{bars ? 'Pixel effects' : 'Pixel effects — drawn for LED bars'}</div>
        <div class="pattern-grid">
          {pixel.map((p) => <PatternButton key={p.id} p={p} active={s.pattern === p.id} onBars={onBars === p.id} />)}
        </div>
      </>}
      {(s.fixtures || []).length >= 3 && (
        <div class="pixel-map" role="group" aria-label="How the pattern is laid over the rig">
          {PIXEL_MAPS.filter((m) => bars || !m.bars).map((m) => (
            <button key={m.id} class={`btn sm ${map === m.id ? 'active' : ''}`}
              aria-pressed={map === m.id} title={m.desc}
              onClick={() => send({ pixelMap: m.id })}>{m.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

