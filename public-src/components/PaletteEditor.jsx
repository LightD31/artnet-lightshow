import { useEffect, useRef, useState } from 'preact/hooks';
import { HEX_COLOUR, parseHex, toHex, paletteBodySchema } from '../../src/shared/palette-model.ts';
import { GradientEditor, gradientSettings } from './GradientEditor.jsx';
import { api, patchLibrary } from '../state.js';

export const MAX_COLOURS = 8;

export function isHexColour(value) {
  return typeof value === 'string' && HEX_COLOUR.test(value);
}
export const isRandom = (entry) => !!entry && typeof entry === 'object' && entry.random === true;

/** A hex colour as the server writes it back: upper case, six or eight digits. */
export function normaliseHex(value) {
  if (!isHexColour(value)) return value;
  const digits = value.slice(1);
  const wide = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
  return `#${wide.toUpperCase()}`;
}

/** What a colour input can show: six digits, lower case, any white channel dropped. */
export function pickerValue(entry) {
  return isHexColour(entry) ? normaliseHex(entry).slice(0, 7).toLowerCase() : '#000000';
}

/** Two palettes with the same entries, whatever the hex spelling. */
export function sameColours(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((c, i) => (isRandom(c) || isRandom(b[i]) ? isRandom(c) && isRandom(b[i]) : normaliseHex(c) === normaliseHex(b[i])));
}

// The built-in palettes have ids, not names; the id reads as words.
const PALETTE_NAMES = { hdDefault: 'Hue Dynamics default', hdStrobe: 'Hue Dynamics strobe', randomRandom: 'Random, Random' };
export function paletteName(palette) {
  if (palette.name) return palette.name;
  if (PALETTE_NAMES[palette.id]) return PALETTE_NAMES[palette.id];
  return palette.id.replace(/([a-z])(?=[A-Z])/g, '$1 ').replace(/^./, (c) => c.toUpperCase());
}

/** Save colours as a palette of your own; the page's library takes it at once. */
export async function savePalette(name, colours) {
  const body = Array.isArray(colours) ? { colours } : colours;
  const res = await api('/api/palettes', { method: 'POST', body: JSON.stringify({ name, ...body }) });
  if (res.ok && res.palette) {
    patchLibrary((lib) => ({
      ...lib, palettes: { ...lib.palettes, user: [...lib.palettes.user.filter((p) => p.id !== res.palette.id), res.palette] },
    }));
  }
  return res;
}

export function PaletteEditor({ colours, onChange, body, onBodyChange, onInvalid, builtin = [], user = [], label = 'Palette' }) {
  // What is typed into a hex field, by index, kept while it is edited; the
  // stored colour is written back on blur or Enter.
  const texts = useRef({});
  const [, redraw] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const list = body?.colours ?? (Array.isArray(colours) ? colours : []);
  const palette = { ...gradientSettings(body || {}), colours: list };
  // Colours changed from outside (revert, recommended, another family) drop what was typed.
  const own = useRef(list);
  if (!sameColours(list, own.current)) { own.current = list; texts.current = {}; }
  const setTexts = (next) => { texts.current = next; redraw((n) => n + 1); };
  const emitBody = (next) => { own.current = next.colours; if (onBodyChange) onBodyChange(next); else onChange(next.colours); };
  const emit = (next) => emitBody({ ...palette, colours: next });
  const setAt = (i, entry) => emit(list.map((c, j) => (j === i ? entry : c)));
  const typed = (i, text) => {
    setTexts({ ...texts.current, [i]: text });
    if (isHexColour(text)) setAt(i, normaliseHex(text));
  };
  const settle = (i) => {
    if (texts.current[i] === undefined || !isHexColour(texts.current[i])) return;
    const { [i]: _done, ...rest } = texts.current;
    setTexts(rest);
  };
  const picked = (i, value) => {
    const { [i]: _done, ...rest } = texts.current;
    setTexts(rest);
    const extra = isHexColour(list[i]) ? normaliseHex(list[i]).slice(7) : '';
    setAt(i, normaliseHex(value) + extra);
  };
  const remove = (i) => {
    setTexts({});
    emitBody({ ...palette, colours: list.filter((_, j) => j !== i), gradients: palette.gradients.map((g) => ({ ...g,
      stops: g.stops.map((s) => 'slot' in s ? { ...s, slot: Math.min(list.length - 2, s.slot >= i ? Math.max(0, s.slot - 1) : s.slot) } : s) })) });
  };
  const add = (entry) => emit([...list, entry]);
  const pickPalette = (e) => {
    const palette = [...builtin, ...user].find((p) => p.id === e.target.value);
    e.target.value = '';
    if (!palette) return;
    setTexts({});
    emitBody({ ...gradientSettings(palette), colours: [...palette.colours] });
  };
  const textAt = (entry, i) => (texts.current[i] !== undefined ? texts.current[i] : (isRandom(entry) ? '' : entry));
  const parsed = paletteBodySchema.safeParse(palette);
  const anyInvalid = !parsed.success || list.some((entry, i) => !isRandom(entry) && !isHexColour(textAt(entry, i)));
  useEffect(() => { if (onInvalid) onInvalid(anyInvalid); }, [anyInvalid]);
  useEffect(() => () => { if (onInvalid) onInvalid(false); }, []);
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !list.length || anyInvalid) return;
    const res = await savePalette(trimmed, onBodyChange ? palette : list);
    if (res.ok) { setNaming(false); setName(''); }
  };
  const byApp = (app) => builtin.filter((p) => p.app === app);
  const randomTitle = 'Light DJ\'s Random: a fresh colour each time the effect starts';

  return (
    <div class="palette-editor" role="group" aria-label={label}>
      <div class="palette-swatches">
        {list.map((entry, i) => {
          const random = isRandom(entry);
          const text = textAt(entry, i);
          const invalid = !random && !isHexColour(text);
          return (
            <div key={i} class={`palette-entry ${invalid ? 'invalid' : ''}`}>
              {random ? <span class="palette-random" title={randomTitle}>Random</span> : <>
                <span class="palette-swatch" style={{ background: pickerValue(entry) }}>
                  <input type="color" aria-label={`Colour ${i + 1} picker`} value={pickerValue(entry)} onInput={(e) => picked(i, e.target.value)} />
                </span>
                <input type="text" class="palette-hex" aria-label={`Colour ${i + 1}`} value={text} maxLength={13} spellcheck={false}
                  aria-invalid={invalid ? 'true' : undefined} onInput={(e) => typed(i, e.target.value)}
                  onBlur={() => settle(i)} onKeyDown={(e) => { if (e.key === 'Enter') settle(i); }} />
                <details class="palette-emitters"><summary>W / A / UV</summary>
                  {['w', 'a', 'uv'].map((die) => <label key={die}>{die.toUpperCase()}
                    <input type="number" min="0" max="255" step="1" aria-label={`Colour ${i + 1} ${die.toUpperCase()}`}
                      value={isHexColour(entry) ? parseHex(entry)[die] : 0} onInput={(e) => {
                        if (isHexColour(entry)) setAt(i, toHex({ ...parseHex(entry), [die]: Number(e.target.value) }));
                      }} />
                  </label>)}
                </details>
              </>}
              <button type="button" class="btn xs" aria-label={`Remove colour ${i + 1}`} disabled={list.length <= 1} onClick={() => remove(i)}>×</button>
            </div>
          );
        })}
      </div>
      {list.length < MAX_COLOURS && (
        <div class="palette-add">
          <button type="button" class="btn sm" onClick={() => add('#FFFFFF')}>+ Colour</button>
          <button type="button" class="btn sm" title={randomTitle} onClick={() => add({ random: true })}>+ Random</button>
        </div>
      )}
      {onBodyChange && <GradientEditor body={palette} onChange={emitBody} />}
      {!parsed.success && <p class="error" role="alert">{parsed.error.issues[0].message}</p>}
      <div class="palette-tools">
        <select class="auto-select" aria-label="Pick a palette" value="" onChange={pickPalette}>
          <option value="">Pick a palette…</option>
          {!!byApp('look').length && <optgroup label="Stage palettes">{byApp('look').map((p) => <option key={p.id} value={p.id}>{paletteName(p)}</option>)}</optgroup>}
          {byApp('ldj').length > 0 && (
            <optgroup label="Light DJ">{byApp('ldj').map((p) => <option key={p.id} value={p.id}>{paletteName(p)}</option>)}</optgroup>
          )}
          {byApp('hd').length > 0 && (
            <optgroup label="Hue Dynamics">{byApp('hd').map((p) => <option key={p.id} value={p.id}>{paletteName(p)}</option>)}</optgroup>
          )}
          {user.length > 0 && (
            <optgroup label="Your palettes">{user.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
          )}
        </select>
        {!naming && <button type="button" class="btn sm" onClick={() => setNaming(true)}>Save as palette…</button>}
      </div>
      {naming && (
        <div class="cue-save-row">
          <input class="cue-name-input" aria-label="Palette name" placeholder="Palette name" value={name} autoFocus
            onInput={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
          <button type="button" class="btn sm" onClick={save} disabled={!name.trim() || anyInvalid}>Save palette</button>
          <button type="button" class="btn sm" onClick={() => setNaming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
