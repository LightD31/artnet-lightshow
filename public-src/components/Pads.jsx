import { useRef, useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { useVoicePads, holdsWhilePressed, padKey } from '../voice-pad.js';
import { quickDeck, readFavourites } from './Effects.jsx';
import { useSafetyGate } from './Photosensitivity.jsx';

/**
 * The deck's pads: two banks of eight, as the server's layout has them. A
 * pad plays as its launch mode says (voice-pad.js); a running voice lights
 * its pad. Editing sits behind "Edit pads" or a long press on a tap pad, so
 * a stray touch mid-set never opens a form.
 */
const BANKS = ['A', 'B'];
const SLOTS = 8;
const GLYPHS = { hold: '●', once: '▶', loop: '↻' };
const HINTS = { hold: 'hold', once: 'tap to play once', loop: 'tap to loop, tap again to stop' };
const QUANTISE = [[0, 'Now'], [0.25, '1/4 beat'], [0.5, '1/2 beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar'], [16, '4 bars']];
const BANK_KEY = 'lightshow.perform.bank';

export const padGlyph = (launch) => GLYPHS[launch] || '';
export const padName = (bank, slot) => `${BANKS[bank]}${slot + 1}`;

function readBank() {
  try { return localStorage.getItem(BANK_KEY) === '1' ? 1 : 0; } catch { return 0; }
}

/** The pad editor's content choices: favourites, saved and party presets first, then everything else. */
export function contentRows(rows, favourites = []) {
  const first = quickDeck(rows, favourites);
  const seen = new Set(first.map((r) => r.id));
  return [...first, ...rows.filter((r) => !seen.has(r.id))];
}

// Catalogue ids are dotted (hd.…, ldj.…, energy.…); saved presets are flagged; the rest are upstream patterns.
const contentValue = (row) => `${row.user || row.id.includes('.') ? 'preset' : 'pattern'}:${row.id}`;

/** What PUT /api/pads/:bank/:slot takes, from the editor's fields. */
export function padBody(draft) {
  const at = draft.content ? draft.content.indexOf(':') : -1;
  const content = at > 0 ? { kind: draft.content.slice(0, at), id: draft.content.slice(at + 1) } : null;
  const targets = Array.isArray(draft.targets) && draft.targets.length ? draft.targets.map(Number) : 'shared';
  return {
    label: String(draft.label ?? '').slice(0, 80),
    accent: String(draft.accent).toUpperCase(),
    content,
    launch: content?.kind === 'strobe' ? 'hold' : draft.launch,
    quantise: Number(draft.quantise) || 0,
    targets,
  };
}

export function Pads({ initialBank }) {
  const s = pick(['pads']);
  const [bank, setBank] = useState(() => initialBank ?? readBank());
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(null);
  const { held, padProps } = useVoicePads({ onLongPress: setOpen });
  const gate = useSafetyGate();
  const layout = s.pads?.layout || [];
  const lit = s.pads?.lit || [];

  const choose = (b) => {
    setBank(b);
    try { localStorage.setItem(BANK_KEY, String(b)); } catch { /* private mode */ }
  };

  const cells = Array.from({ length: SLOTS }, (_, slot) =>
    layout.find((p) => p.bank === bank && p.slot === slot) || { bank, slot, label: '', accent: '#444444', content: null, launch: 'once' });

  return (
    <section class="perform-pads" aria-label="Pads">
      <div class="pad-bar">
        <div role="tablist" aria-label="Pad banks" class="pad-banks">
          {BANKS.map((name, b) => (
            <button key={name} type="button" role="tab" aria-selected={bank === b} class="pad-bank" onClick={() => choose(b)}>{name}</button>
          ))}
        </div>
        <button type="button" class="pad-edit-toggle" aria-pressed={editing} onClick={() => setEditing(!editing)}>Edit pads</button>
      </div>
      <div class="pad-grid" role="tabpanel" aria-label={`Bank ${BANKS[bank]}`}>
        {cells.map((entry) => {
          const index = entry.bank * SLOTS + entry.slot;
          const on = !!lit[index] || held.has(padKey(entry.bank, entry.slot));
          const name = entry.label || (entry.content ? entry.content.id : 'Empty');
          // A strobe pad asks before the acknowledgement, as the strobe button does.
          const asks = !editing && entry.content?.kind === 'strobe' && !gate.acknowledged;
          const handlers = editing ? { onClick: () => setOpen(entry) }
            : asks ? { onClick: () => gate.guard(name, () => {}), 'data-safety': 'ask' } : padProps(entry);
          delete handlers.style;
          return (
            <button key={index} type="button"
              class={`pad-cell${entry.content ? '' : ' empty'}${on ? ' lit' : ''}`}
              style={{ '--pad-accent': entry.accent }}
              data-bank={entry.bank} data-slot={entry.slot}
              title={entry.content ? `${name} — ${holdsWhilePressed(entry) ? HINTS.hold : HINTS[entry.launch]}` : 'Empty — Edit pads to fill'}
              aria-pressed={on}
              disabled={!entry.content && !editing}
              {...handlers}>
              <span class="pad-label">{entry.label || (entry.content ? name : 'Empty')}</span>
              <span class="pad-glyph" aria-hidden="true">{entry.content ? padGlyph(holdsWhilePressed(entry) ? 'hold' : entry.launch) : ''}</span>
            </button>
          );
        })}
      </div>
      {open && <PadEditor entry={open} onClose={() => setOpen(null)} />}
      {gate.dialog}
    </section>
  );
}

/** The pad editor, as a sheet: content from the library, launch, quantise, fixtures. */
export function PadEditor({ entry, onClose }) {
  const s = pick(['patterns', 'effects', 'fixtures']);
  const box = useRef(null);
  useFocusTrap(box, true, onClose);
  const current = entry.content ? `${entry.content.kind}:${entry.content.id}` : '';
  const [draft, setDraft] = useState({
    label: entry.label, accent: entry.accent, content: current, launch: entry.launch,
    quantise: entry.quantise ?? 0.25, targets: Array.isArray(entry.targets) ? entry.targets : [],
  });
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const userRows = (s.effects || []).map((e) => ({ ...e, user: true }));
  const rows = contentRows([...userRows, ...(s.patterns || [])], readFavourites());
  const values = new Set(rows.map(contentValue));
  const strobe = draft.content === 'strobe:strobe';
  const toggleFixture = (id, on) => set({ targets: on ? [...draft.targets, id] : draft.targets.filter((t) => t !== id) });

  const save = async () => {
    const res = await api(`/api/pads/${entry.bank}/${entry.slot}`, { method: 'PUT', body: JSON.stringify(padBody(draft)) });
    if (res.ok) onClose();
  };

  return (
    <div class="effect-sheet-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class="effect-sheet pad-editor" role="dialog" aria-modal="true" aria-label={`Edit pad ${padName(entry.bank, entry.slot)}`} tabIndex={-1}>
        <h2>Pad {padName(entry.bank, entry.slot)}</h2>
        <label class="pad-field"><span>Plays</span>
          <select value={draft.content} onChange={(e) => set({ content: e.target.value })}>
            <option value="" selected={draft.content === ''}>Nothing</option>
            <option value="strobe:strobe" selected={strobe}>Strobe (held)</option>
            {current && current !== 'strobe:strobe' && !values.has(current) && <option value={current} selected={draft.content === current}>{entry.content.id}</option>}
            {rows.map((row) => {
              const value = contentValue(row);
              return <option key={value} value={value} selected={draft.content === value}>{row.name}</option>;
            })}
          </select>
        </label>
        <label class="pad-field"><span>Label</span>
          <input type="text" maxLength={80} value={draft.label} onInput={(e) => set({ label: e.target.value })} />
        </label>
        <label class="pad-field"><span>Colour</span>
          <input type="color" value={draft.accent.toLowerCase()} onInput={(e) => set({ accent: e.target.value })} />
        </label>
        <fieldset class="pad-field" disabled={strobe}><legend>Launch</legend>
          {['once', 'hold', 'loop'].map((mode) => (
            <label key={mode} class="pad-choice">
              <input type="radio" name="pad-launch" value={mode} checked={(strobe ? 'hold' : draft.launch) === mode} onChange={() => set({ launch: mode })} />
              <span>{padGlyph(mode)} {mode === 'once' ? 'Once' : mode === 'hold' ? 'Hold' : 'Loop'}</span>
            </label>
          ))}
        </fieldset>
        <label class="pad-field"><span>Starts on</span>
          <select value={String(draft.quantise)} onChange={(e) => set({ quantise: Number(e.target.value) })}>
            {QUANTISE.map(([beats, text]) => <option key={beats} value={String(beats)} selected={Number(draft.quantise) === beats}>{text}</option>)}
          </select>
        </label>
        <fieldset class="pad-field pad-targets"><legend>Fixtures (none ticked: the whole rig)</legend>
          {(s.fixtures || []).map((f) => (
            <label key={f.id} class="pad-choice">
              <input type="checkbox" value={String(f.id)} checked={draft.targets.includes(f.id)} onChange={(e) => toggleFixture(f.id, e.target.checked)} />
              <span>{f.name}</span>
            </label>
          ))}
        </fieldset>
        <div class="pad-editor-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" class="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
