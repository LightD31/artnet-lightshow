import { useState } from 'preact/hooks';
import { api, patchLibrary } from '../state.js';

// Palettes travel as hex: #RGB, #RRGGBB or #RRGGBBWW, as the server's palette
// store takes them. A Light DJ "Random" entry stays a sentinel until an
// instance rolls it, so the editor shows it as a word rather than a colour.
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const MAX_COLOURS = 8;

export function isHexColour(value) {
  return typeof value === 'string' && HEX_RE.test(value);
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

// The built-in palettes have ids, not names; the id reads as words.
const PALETTE_NAMES = { hdDefault: 'Hue Dynamics default', hdStrobe: 'Hue Dynamics strobe', randomRandom: 'Random, Random' };
export function paletteName(palette) {
  if (palette.name) return palette.name;
  if (PALETTE_NAMES[palette.id]) return PALETTE_NAMES[palette.id];
  return palette.id.replace(/([a-z])(?=[A-Z])/g, '$1 ').replace(/^./, (c) => c.toUpperCase());
}

/** Save colours as a palette of your own; the page's library takes it at once. */
export async function savePalette(name, colours) {
  const res = await api('/api/palettes', { method: 'POST', body: JSON.stringify({ name, colours }) });
  if (res.ok && res.palette) {
    patchLibrary((lib) => ({
      ...lib, palettes: { ...lib.palettes, user: [...lib.palettes.user.filter((p) => p.id !== res.palette.id), res.palette] },
    }));
  }
  return res;
}

/**
 * One to eight colours, each a swatch that opens the native picker beside a
 * hex field, or Light DJ's Random; a whole palette picked from the built-ins
 * and the ones saved here; the lot saved as a palette of your own.
 */
export function PaletteEditor({ colours, onChange, builtin = [], user = [], label = 'Palette' }) {
  // What is being typed into a hex field, by index, until it is a colour.
  const [texts, setTexts] = useState({});
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const list = Array.isArray(colours) ? colours : [];

  const setAt = (i, entry) => onChange(list.map((c, j) => (j === i ? entry : c)));
  const typed = (i, text) => {
    if (isHexColour(text)) {
      setTexts((t) => ({ ...t, [i]: undefined }));
      setAt(i, normaliseHex(text));
    } else {
      setTexts((t) => ({ ...t, [i]: text }));
    }
  };
  const remove = (i) => { setTexts({}); onChange(list.filter((_, j) => j !== i)); };
  const add = (entry) => onChange([...list, entry]);
  const pickPalette = (e) => {
    const palette = [...builtin, ...user].find((p) => p.id === e.target.value);
    e.target.value = '';
    if (!palette) return;
    setTexts({});
    onChange([...palette.colours]);
  };
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !list.length) return;
    const res = await savePalette(trimmed, list);
    if (res.ok) { setNaming(false); setName(''); }
  };
  const byApp = (app) => builtin.filter((p) => p.app === app);
  const randomTitle = 'Light DJ\'s Random: a fresh colour each time the effect starts';

  return (
    <div class="palette-editor" role="group" aria-label={label}>
      <div class="palette-swatches">
        {list.map((entry, i) => {
          const random = isRandom(entry);
          const text = texts[i] !== undefined ? texts[i] : (random ? '' : entry);
          const invalid = !random && !isHexColour(text);
          return (
            <div key={i} class={`palette-entry ${invalid ? 'invalid' : ''}`}>
              {random ? <span class="palette-random" title={randomTitle}>Random</span> : <>
                <span class="palette-swatch" style={{ background: pickerValue(entry) }}>
                  <input type="color" aria-label={`Colour ${i + 1} picker`} value={pickerValue(entry)} onInput={(e) => typed(i, e.target.value)} />
                </span>
                <input type="text" class="palette-hex" aria-label={`Colour ${i + 1}`} value={text} maxLength={9} spellcheck={false}
                  aria-invalid={invalid ? 'true' : undefined} onInput={(e) => typed(i, e.target.value)} />
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
      <div class="palette-tools">
        <select class="auto-select" aria-label="Pick a palette" value="" onChange={pickPalette}>
          <option value="">Pick a palette…</option>
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
          <button type="button" class="btn sm" onClick={save} disabled={!name.trim()}>Save palette</button>
          <button type="button" class="btn sm" onClick={() => setNaming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
