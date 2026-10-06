import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { librarySig, pick, send } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { Inspector, familyOf } from './Inspector.jsx';
import { Photosensitivity as PhotosensitivityConfirm, acknowledgeThen } from './Photosensitivity.jsx';

/**
 * The Effects view: an instrument first, an editor second. At the top a deck
 * of big pads — the favourites, the presets saved here and the party looks —
 * with the one on stage marked; under a sticky search and the filter chips,
 * the whole catalogue by app and family (Hue Dynamics, Light DJ, the fork's
 * own, the upstream patterns), each group folded until opened. A plain tap
 * puts a row on stage and nothing else; its pencil, or a long press, opens
 * the inspector for it, in a sheet over the page.
 */

const APP_NAMES = { hd: 'Hue Dynamics', ldj: 'Light DJ', own: 'Own', upstream: 'Upstream patterns' };
const APP_BADGES = { hd: 'Hue Dynamics', ldj: 'Light DJ', own: 'Own', upstream: 'Upstream' };
const APP_ORDER = ['hd', 'ldj', 'own', 'upstream'];
const APP_ICONS = { hd: '◆', ldj: '♪', own: '◉', upstream: '·' };
const FLAG_CHIPS = [
  ['party', 'Party', 'Across the room, where the lamps stand'], ['pixel', 'Pixel', 'Drawn for LED bars'],
  ['rapid', 'Rapid flash', 'Needs the photosensitivity acknowledgement'],
];
const LIBRARY_MODES = [
  ['single', 'Single', 'The one-beat presets'], ['multi', 'Multi', 'The presets that play over a bar or longer'],
  ['custom', 'Custom', 'The presets saved on this server'], ['all', 'All', 'Everything'],
];
const FAVOURITES_KEY = 'lightshow.effects.favourites';
const LONG_PRESS_MS = 500;
// The bars that stay at the top of the page while it scrolls; the search sticks under them.
const STUCK_BARS = '.app-header, .command-bar, .mode-tabs';

/** The preset the inspector is open on, or null: one editor for the page, so a pad elsewhere can open it too. */
export const editingSig = signal(null);

// Map pattern ids to a unicode glyph; a preset takes its app's.
const PATTERN_ICONS = {
  solid: '●', chase: '→', 'chase-rev': '←', 'ping-pong': '⇄', strobe: '⚡', fade: '◐', 'color-cycle': '◌', rainbow: '✦',
  twinkle: '✶', split: '◧', sparkle: '✧', wave: '∿', 'stack-up': '⇡', 'random-flash': '⚹', runner: '➤', pairs: '⋮⋮', hit: '✖',
  'alt-halves': '◨', 'split-3': '⫶', 'chase-3': '➰', 'alt-thirds': '☷', 'split-4': '⊞', 'chase-4': '⟳', 'alt-quarters': '⊠',
  'pairs-4': '⫴', sections: '▥', ensemble: '◉', ribbon: '〰', gradient: '▤', comet: '☄', burst: '◎', plasma: '≋', meter: '▮',
  drums: '◍', stems: '☰', rise: '▲', impact: '✺', bars: '▁▅▃', fire: '♨', rain: '⁞', 'position-chase': '⇶', 'radial-pulse': '◉',
  'spatial-wash': '≈', 'bounce-scan': '↔', streak: '⟿', starlight: '✵', breathe: '◯', 'volume-gate': '◫', confetti: '❉',
  'anchor-fill': '⊞', halves: '◧', flip: '◩', 'room-wave': '〜', 'ring-strobe': '◌', 'ring-backlit': '◍', fireworks: '✸',
  flashes: '⚡', swirl: '↻',
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

/** Does the patch have a panel: a fixture whose cells stand in rows? */
function hasPanels(s) {
  const profiles = s.profiles || {};
  return (s.fixtures || []).some((f) => {
    const p = profiles[f.profileId];
    // A panel of zones (a strobe panel) plays the bars' programs, not a screen's.
    return !!(p && p.grid && !p.zoned && Array.isArray(p.cells) && p.cells.length >= 2);
  });
}

/** Which group a row belongs to: a saved preset and a party look are the fork's own; a row with no app is upstream. */
export function appOf(row) {
  if (row.user) return 'own';
  if (row.app) return row.app;
  return row.party ? 'own' : 'upstream';
}

/** Hue Dynamics' Library filter: Single and Multi by scope, Custom the presets saved here, All everything. */
export function filterByLibrary(rows, mode) {
  switch (mode) {
    case 'single': return rows.filter((r) => r.scope === 'singleBeat');
    case 'multi': return rows.filter((r) => r.scope === 'measure');
    case 'custom': return rows.filter((r) => r.user);
    default: return rows;
  }
}

/** The rows by app, each app by family, in the catalogue's order; the saved presets lead the fork's own. */
export function groupRows(rows, families = []) {
  const rank = new Map(families.map((f, i) => [f.id, i]));
  const nameOf = (id) => families.find((f) => f.id === id)?.name || id;
  const groups = new Map();
  for (const row of rows) {
    const app = appOf(row);
    const fam = row.user ? { id: 'user', name: 'Your presets', rank: -1 }
      : app === 'upstream' ? (row.pixel ? { id: 'pixel', name: 'Pixel effects', rank: 1 } : { id: 'patterns', name: 'Patterns', rank: 0 })
        : row.app ? { id: row.family, name: nameOf(row.family), rank: rank.get(row.family) ?? 999 }
          : { id: 'own.party', name: nameOf('own.party'), rank: rank.get('own.party') ?? 999 };
    if (!groups.has(app)) groups.set(app, new Map());
    const group = groups.get(app);
    if (!group.has(fam.id)) group.set(fam.id, { ...fam, rows: [] });
    group.get(fam.id).rows.push(row);
  }
  return APP_ORDER.filter((app) => groups.has(app)).map((app) => ({
    app, name: APP_NAMES[app], families: [...groups.get(app).values()].sort((a, b) => a.rank - b.rank),
  }));
}

/** The deck: the favourites in the order they were starred, then the presets saved here, then the party looks. */
export function quickDeck(rows, favourites = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pinned = favourites.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
  const rest = rows.filter((r) => !favourites.includes(r.id));
  return [...pinned, ...rest.filter((r) => r.user), ...rest.filter((r) => r.party && !r.user)];
}

/** What a plain tap does: puts the row on stage, nothing else. A rapid flash before the acknowledgement asks first. */
export function tapRow(row, acknowledged, ask = () => {}) {
  if (row.rapidFlash && !acknowledged) {
    ask(row);
    return false;
  }
  return send({ pattern: row.id });
}

// The favourites live in this browser, as the view mode does.
export function readFavourites() {
  try {
    const ids = JSON.parse(localStorage.getItem(FAVOURITES_KEY) || '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function writeFavourites(ids) {
  try { localStorage.setItem(FAVOURITES_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
}

function matches(row, q, families) {
  if (!q) return true;
  const family = row.family ? families.find((f) => f.id === row.family) : null;
  return [row.name, row.desc, row.id, family && family.name].some((text) => text && text.toLowerCase().includes(q));
}

// The warning before the first rapid flash, shared with the strobe pad and the matrix.
export { PhotosensitivityConfirm };

/** The press logic behind usePress; `stop` cancels a pending long press. */
export function createPress(callbacks) {
  let timer = null;
  let pressed = false;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const handlers = {
    onPointerDown: () => { pressed = false; stop(); timer = setTimeout(() => { timer = null; pressed = true; callbacks.onLongPress(); }, LONG_PRESS_MS); },
    onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop,
    onClick: () => { if (pressed) { pressed = false; return; } callbacks.onTap(); },
    // A long press on a touch screen is the editor's, not the browser menu's.
    onContextMenu: (e) => e.preventDefault(),
  };
  return { handlers, stop };
}

/** A tap target that also takes a long press: the press opens the editor, and the click that follows it is not a tap. */
export function usePress(onTap, onLongPress) {
  const latest = useRef(null);
  latest.current = { onTap, onLongPress };
  const press = useRef(null);
  if (!press.current) press.current = createPress({ onTap: () => latest.current.onTap(), onLongPress: () => latest.current.onLongPress() });
  // A row removed mid-press must not open the sheet on it.
  useEffect(() => press.current.stop, []);
  return press.current.handlers;
}

/** Where the search sticks: under whichever of the page's bars are stuck at this width. */
function useStickyTop(ref) {
  useEffect(() => {
    const place = () => {
      if (!ref.current) return;
      let top = 0;
      for (const el of document.querySelectorAll(STUCK_BARS)) {
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky') top = Math.max(top, (parseFloat(cs.top) || 0) + el.getBoundingClientRect().height);
      }
      ref.current.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
}

/** The inspector as a sheet over the page: opened by Edit or a long press, closed by Close, Escape or the veil. */
function InspectorSheet({ id, onSelect, onPlay, onClose }) {
  const box = useRef(null);
  useFocusTrap(box, true, onClose);
  return (
    <div class="effect-sheet-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class="effect-sheet" role="dialog" aria-modal="true" aria-label="Edit effect" tabIndex={-1}>
        <Inspector id={id} onSelect={onSelect} onPlay={onPlay} onClose={onClose} />
      </div>
    </div>
  );
}

const Rapid = () => (
  <span class="badge-rapid" role="img" aria-label="rapid flash" title="Rapid flash: plays only after the photosensitivity acknowledgement">⚡</span>
);

function Star({ row, on, onToggle }) {
  return (
    <button type="button" class={`effect-star ${on ? 'on' : ''}`} aria-pressed={on} aria-label={`Favourite ${row.name}`}
      title={on ? 'Unpin from the deck' : 'Pin to the deck'} onClick={() => onToggle(row.id)}>{on ? '★' : '☆'}</button>
  );
}

function EditButton({ row, onEdit }) {
  return (
    <button type="button" class="effect-edit" aria-label={`Edit ${row.name}`} title="Open in the inspector" onClick={() => onEdit(row.id)}>✎</button>
  );
}

/** A deck pad: the name large, the app under it, the one on stage marked. */
function Pad({ row, active, favourite, onTap, onEdit, onToggleFavourite }) {
  const press = usePress(() => onTap(row), () => onEdit(row.id));
  return (
    <div class={`effect-pad ${active ? 'active' : ''}`} data-id={row.id}>
      <button type="button" class="effect-pad-tap" aria-pressed={active} title={row.desc || row.name} {...press}>
        <span class="effect-pad-name">{row.name}</span>
        <span class="effect-pad-app">{APP_BADGES[row.user ? row.kindApp || 'own' : appOf(row)]}{row.user && <span class="effect-pad-yours"> · Yours</span>}</span>
        {active && <span class="effect-pad-now">Now playing</span>}
        {row.rapidFlash && <Rapid />}
      </button>
      <div class="effect-pad-tools">
        <Star row={row} on={favourite} onToggle={onToggleFavourite} />
        <EditButton row={row} onEdit={onEdit} />
      </div>
    </div>
  );
}

/** A catalogue row: the pattern button as the Manual view has always had it, with the star and the pencil beside. */
function Row({ row, active, onBars, onPanels, favourite, onTap, onEdit, onToggleFavourite }) {
  const press = usePress(() => onTap(row), () => onEdit(row.id));
  const where = [onBars && 'the bars', onPanels && 'the panels'].filter(Boolean).join(' and ');
  return (
    <div class="effect-row">
      <button type="button" class={`pattern-btn ${active ? 'active' : ''} ${where ? 'on-bars' : ''}`} data-id={row.id}
        aria-pressed={active} title={row.desc || row.name} {...press}>
        <span class="icon" aria-hidden="true">{PATTERN_ICONS[row.id] || APP_ICONS[appOf(row)]}</span>
        <span class="body">
          <span class="name">{row.name}{where && <span class="layer-tag"> · on {where}</span>}</span>
        </span>
        {row.rapidFlash && <Rapid />}
      </button>
      <Star row={row} on={favourite} onToggle={onToggleFavourite} />
      <EditButton row={row} onEdit={onEdit} />
    </div>
  );
}

export function Effects() {
  const s = pick(['pattern', 'patterns', 'families', 'effects', 'safety', 'pixelMap', 'pixelPattern', 'panelPattern', 'fixtures', 'profiles']);
  const lib = librarySig.value;
  const editing = editingSig.value;
  const families = s.families || lib.families || [];
  const [q, setQ] = useState('');
  const [flags, setFlags] = useState({ party: false, pixel: false, rapid: false });
  const [library, setLibrary] = useState('all');
  const [favourites, setFavourites] = useState(readFavourites);
  const [confirm, setConfirm] = useState(null);
  const tools = useRef(null);
  useStickyTop(tools);
  const acknowledged = !!(s.safety && s.safety.photosensitivityAcknowledged);

  // The presets saved here ride the live state as summaries; they list like the built-ins.
  const userRows = (s.effects || []).map((e) => {
    const family = familyOf(e.kind, families);
    return { ...e, user: true, app: 'own', kindApp: family?.app, family: family?.id || 'user', desc: 'A preset saved on this server' };
  });
  const rows = [...userRows, ...(s.patterns || [])];
  const query = q.trim().toLowerCase();
  const visible = filterByLibrary(rows, library)
    .filter((r) => (!flags.party || r.party) && (!flags.pixel || r.pixel) && (!flags.rapid || r.rapidFlash))
    .filter((r) => matches(r, query, families));
  const deck = quickDeck(visible, favourites);
  const groups = groupRows(visible, families);

  const tap = (row) => tapRow(row, acknowledged, setConfirm);
  const confirmPlay = async () => {
    const row = confirm;
    setConfirm(null);
    await acknowledgeThen(() => send({ pattern: row.id }));
  };
  const playById = (id) => {
    const row = rows.find((r) => r.id === id);
    if (row) tap(row); else send({ pattern: id });
  };
  const edit = (id) => { editingSig.value = id; };
  const toggleFavourite = (id) => {
    const next = favourites.includes(id) ? favourites.filter((x) => x !== id) : [...favourites, id];
    setFavourites(next);
    writeFavourites(next);
  };
  const toggleFlag = (flag) => setFlags((f) => ({ ...f, [flag]: !f[flag] }));

  const bars = hasBars(s);
  // The auto show gives the pars and the bars a look each, and the panels
  // theirs. Both are marked; a pattern picked here runs on the whole rig again.
  const onBars = bars && s.pixelPattern ? s.pixelPattern : null;
  const panels = hasPanels(s);
  const onPanels = panels && s.panelPattern ? s.panelPattern : null;
  const nameOf = (id) => rows.find((p) => p.id === id)?.name || id;
  const playing = s.pattern ? rows.find((r) => r.id === s.pattern) || { id: s.pattern, name: s.pattern } : null;
  const pixel = (s.patterns || []).filter((p) => p.pixel);
  // Along each bar is across the stage on a rig without bars.
  const map = !bars && s.pixelMap === 'bar' ? 'stage' : (s.pixelMap || 'stage');
  const rowProps = (row) => ({
    row, active: s.pattern === row.id, favourite: favourites.includes(row.id), onTap: tap, onEdit: edit, onToggleFavourite: toggleFavourite,
  });

  return <>
    <div class="card effects">
      <div class="card-title">Effects</div>
      <div class="effects-tools" ref={tools}>
        {playing && (
          <div class="effects-now" role="status" aria-live="polite">
            <span class="effects-now-label">Now playing</span>
            <span class="effects-now-name">{playing.name}</span>
            {(playing.app || playing.user) && <span class="effects-now-app">{APP_BADGES[playing.user ? playing.kindApp || 'own' : appOf(playing)]}</span>}
            {(onBars || onPanels) && (
              <span class="effects-now-layers">
                {[onBars && `on the pars, bars on ${nameOf(onBars)}`, onPanels && `panels on ${nameOf(onPanels)}`].filter(Boolean).join(', ')}
              </span>
            )}
            <EditButton row={playing} onEdit={edit} />
          </div>
        )}
        <input class="effects-search" type="search" aria-label="Search effects" placeholder="Search effects" value={q} onInput={(e) => setQ(e.target.value)} />
        <div class="effects-chips" role="group" aria-label="Filters">
          {FLAG_CHIPS.map(([flag, label, desc]) => (
            <button key={flag} class={`effects-chip ${flags[flag] ? 'active' : ''}`} aria-pressed={flags[flag]} type="button" title={desc}
              onClick={() => toggleFlag(flag)}>{label}</button>
          ))}
          <span class="effects-chip-sep" role="presentation" />
          {LIBRARY_MODES.map(([id, label, desc]) => (
            <button key={id} class={`effects-chip library ${library === id ? 'active' : ''}`} aria-pressed={library === id} type="button" title={desc}
              onClick={() => setLibrary(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div class="effects-deck" role="group" aria-label="Favourites, your presets and the party looks">
        {deck.length === 0 && <p class="effects-empty">{query ? 'Nothing on the deck matches.' : 'Star an effect to pin it here.'}</p>}
        {deck.map((row) => <Pad key={row.id} {...rowProps(row)} />)}
      </div>
      <div class="effects-catalogue">
        {groups.length === 0 && <p class="effects-empty">Nothing matches.</p>}
        {groups.map((group) => (
          <details key={group.app} class="effects-group" open={!!query}>
            <summary class="effects-group-title">{group.name}</summary>
            {group.families.map((family) => (
              <div key={family.id} class="effects-family">
                <div class="effects-family-title">{family.name}</div>
                <div class="pattern-grid">
                  {family.rows.map((row) => (
                    <Row key={row.id} {...rowProps(row)} onBars={onBars === row.id} onPanels={onPanels === row.id} />
                  ))}
                </div>
              </div>
            ))}
          </details>
        ))}
      </div>
      {panels && pixel.length > 0 && (
        <label class="panel-pattern">
          <span>Panels</span>
          <select class="auto-select" value={onPanels || ''} aria-label="The panels' own picture"
            onChange={(e) => send({ panelPattern: e.target.value || null })}>
            <option value="">Same as the bars</option>
            {pixel.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {(s.fixtures || []).length >= 3 && (
        <div class="pixel-map" role="group" aria-label="How the pattern is laid over the rig">
          {PIXEL_MAPS.filter((m) => bars || !m.bars).map((m) => (
            <button key={m.id} type="button" class={`btn sm ${map === m.id ? 'active' : ''}`}
              aria-pressed={map === m.id} title={m.desc}
              onClick={() => send({ pixelMap: m.id })}>{m.name}</button>
          ))}
        </div>
      )}
    </div>
    {editing && <InspectorSheet id={editing} onSelect={edit} onPlay={playById} onClose={() => edit(null)} />}
    {confirm && <PhotosensitivityConfirm preset={confirm} onConfirm={confirmPlay} onCancel={() => setConfirm(null)} />}
  </>;
}
