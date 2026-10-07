export const VIEWS = [
  { id: 'perform', key: '1', icon: '◉', label: 'Perform', hint: 'Pads · Strobe · Matrix', group: 'live' },
  { id: 'effects', key: '2', icon: '◧', label: 'Effects', hint: 'Look · Colours · Fixtures', group: 'live' },
  { id: 'auto', key: '3', icon: '✦', label: 'Auto Show', hint: 'Music · Timeline · Rehearse', group: 'live' },
  { id: 'sequence', key: '4', icon: '▤', label: 'Sequence', hint: 'Lanes · Patterns · Record', group: 'live' },
  { id: 'stage', key: '5', icon: '◭', label: 'Stage', hint: 'The rig in 3D', group: 'live' },
  { id: 'rig', key: '6', icon: '▦', label: 'Rig', hint: 'Plan · Patch · Outputs', group: 'setup' },
  { id: 'sources', key: '7', icon: '♫', label: 'Sources', hint: 'Players · Spotify · Live input', group: 'setup' },
  { id: 'settings', key: '8', icon: '⚙', label: 'Settings', hint: 'Show · MIDI · Server', group: 'setup' },
  { id: 'preflight', key: '9', icon: '✓', label: 'Preflight', hint: 'Pre-show check', group: 'setup' },
];
export const VIEW_IDS = VIEWS.map((v) => v.id);

export function viewShortcut(event) {
  if (event.repeat || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) || event.target?.isContentEditable) return null;
  return VIEWS.find((view) => !!view.shift === !!event.shiftKey
    && (view.shift ? event.code === `Digit${view.key}` : event.key === view.key)) || null;
}

const ALIASES = { manual: 'effects', timeline: 'auto/timeline', matrix: 'perform/matrix' };

export function resolveRoute(hash) {
  const path = String(hash || '').replace(/^#/, '');
  const [head, ...tail] = path.split('/');
  const canonical = [ALIASES[head] || head, ...tail].filter(Boolean).join('/');
  const [view, sub] = canonical.split('/');
  return VIEW_IDS.includes(view) ? { view, sub: sub || null, canonical } : null;
}
