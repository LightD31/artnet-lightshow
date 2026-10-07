export const VIEWS = [
  { id: 'manual', key: '1', icon: '◧', label: 'Manual', hint: 'Patterns · Colours · Fixtures', group: 'live' },
  { id: 'auto', key: '2', icon: '✦', label: 'Auto Show', hint: 'Spotify · Now Playing · PRO DJ LINK', group: 'live' },
  { id: 'perform', key: '3', icon: '◉', label: 'Perform', hint: 'Pads · Palettes · Faders', group: 'live' },
  { id: 'timeline', key: '4', icon: '≋', label: 'Timeline', hint: 'Sections · Rehearse · Edits', group: 'live' },
  { id: 'stage', key: '5', icon: '◭', label: 'Stage', hint: 'The rig in 3D', group: 'live' },
  { id: 'sequence', key: '0', icon: '▤', label: 'Sequence', hint: 'Lanes · Patterns · Record', group: 'live' },
  { id: 'matrix', key: '0', shift: true, icon: '▩', label: 'Matrix', hint: 'Hold colours', group: 'live' },
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
