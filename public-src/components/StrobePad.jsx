import { useRef, useState } from 'preact/hooks';
import { api, librarySig, pick } from '../state.js';
import { useFocusTrap } from '../focus-trap.js';
import { useVoicePads } from '../voice-pad.js';
import { PaletteEditor, isHexColour, normaliseHex } from './PaletteEditor.jsx';
import { useSafetyGate } from './Photosensitivity.jsx';

/**
 * The strobe: held under a finger, above every other voice. Touch screens
 * that drop long holds get "Burst 2 s". The gear opens its settings, which
 * apply as they change.
 */
const BURST_MS = 2000;
const MAX_COLOURS = 6;
const MAX_FLASHES = 5;

/** What PUT /api/strobe takes, from the sheet's fields: hex colours only, at most six. */
export function strobeBody(d) {
  const palette = (d.palette || []).filter(isHexColour).map((c) => normaliseHex(c).toUpperCase()).slice(0, MAX_COLOURS);
  return {
    palette,
    flashesPerSecond: Math.min(MAX_FLASHES, Math.max(1, Math.round(Number(d.flashesPerSecond) || 1))),
    continueBetween: !!d.continueBetween,
    clock: d.clock === 'beat' ? 'beat' : 'wall',
    brightness: Math.min(100, Math.max(0, Number(d.brightness) || 0)) / 100,
  };
}

export function StrobePad() {
  const s = pick(['strobe']);
  const [open, setOpen] = useState(false);
  const { held, holdProps } = useVoicePads();
  const on = !!s.strobe?.active || held.has('strobe');
  const gate = useSafetyGate();
  // Before the acknowledgement a press asks instead of holding: the finger is
  // gone by the time the question is answered, so the next press holds.
  const handlers = gate.acknowledged
    ? holdProps('strobe', { effect: { preset: 'strobe' } })
    : { onClick: () => gate.guard('Strobe', () => {}), 'data-safety': 'ask' };
  delete handlers.style;
  const hint = on ? 'flashing' : gate.acknowledged ? 'hold' : 'confirm first';
  return (
    <section class="strobe-pad" aria-label="Strobe">
      <button type="button" class={`strobe-hold${on ? ' active' : ''}`} aria-pressed={on} {...handlers}>
        <span class="strobe-name">Strobe</span>
        <span class="strobe-hint">{hint}</span>
      </button>
      <button type="button" class="strobe-burst"
        onClick={() => gate.guard('Strobe', () => api(`/api/strobe/burst/${BURST_MS}`, { method: 'POST' }))}>Burst 2 s</button>
      <button type="button" class="strobe-gear" aria-label="Strobe settings" onClick={() => setOpen(true)}>⚙</button>
      {open && <StrobeSettings onClose={() => setOpen(false)} />}
      {gate.dialog}
    </section>
  );
}

export function StrobeSettings({ onClose }) {
  const s = pick(['strobe', 'userPalettes']);
  const box = useRef(null);
  useFocusTrap(box, true, onClose);
  const settings = s.strobe?.settings || {};
  const [draft, setDraft] = useState(() => ({ ...settings, brightness: Math.round((settings.brightness ?? 1) * 100) }));
  const lib = librarySig.value;

  const apply = (patch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    api('/api/strobe', { method: 'PUT', body: JSON.stringify(strobeBody(next)) });
  };

  return (
    <div class="effect-sheet-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} class="effect-sheet strobe-settings" role="dialog" aria-modal="true" aria-label="Strobe settings" tabIndex={-1}>
        <h2>Strobe</h2>
        <PaletteEditor label={`Colours (up to ${MAX_COLOURS})`} colours={(draft.palette || []).slice(0, MAX_COLOURS)}
          builtin={lib.palettes?.builtin || []} user={s.userPalettes || lib.palettes?.user || []}
          onChange={(palette) => apply({ palette: palette.slice(0, MAX_COLOURS) })} />
        <label class="pad-field"><span>Flashes per second: {draft.flashesPerSecond}</span>
          <input type="range" aria-label="Flashes per second" min="1" max={String(MAX_FLASHES)} step="1" value={draft.flashesPerSecond}
            onInput={(e) => setDraft({ ...draft, flashesPerSecond: Number(e.target.value) })}
            onChange={(e) => apply({ flashesPerSecond: Number(e.target.value) })} />
        </label>
        <label class="pad-choice">
          <input type="checkbox" checked={!!draft.continueBetween} onChange={(e) => apply({ continueBetween: e.target.checked })} />
          <span>Look shows between flashes</span>
        </label>
        <label class="pad-field"><span>Clock</span>
          <select value={draft.clock} onChange={(e) => apply({ clock: e.target.value })}>
            <option value="wall" selected={draft.clock !== 'beat'}>Steady (flashes per second)</option>
            <option value="beat" selected={draft.clock === 'beat'}>On the beat</option>
          </select>
        </label>
        <label class="pad-field"><span>Brightness: {draft.brightness} %</span>
          <input type="range" aria-label="Strobe brightness" min="0" max="100" step="5" value={draft.brightness}
            onInput={(e) => setDraft({ ...draft, brightness: Number(e.target.value) })}
            onChange={(e) => apply({ brightness: Number(e.target.value) })} />
        </label>
        <div class="pad-editor-actions">
          <button type="button" class="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
