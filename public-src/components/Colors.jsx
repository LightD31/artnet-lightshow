import { useState, useEffect, useRef } from 'preact/hooks';
import { stateSig, send } from '../state.js';
import { colorToCss } from '../utils.js';

const SLOTS = [
  { key: 'colorA', label: 'A', cssVar: 'var(--accent)' },
  { key: 'colorB', label: 'B', cssVar: 'var(--accent-2)' },
  { key: 'colorC', label: 'C', cssVar: 'var(--accent-3)' },
  { key: 'colorD', label: 'D', cssVar: 'var(--accent-4)' },
];

const PALETTE_SIZES = [
  { size: 2, hint: 'Two contrasting colours — reads cleanly on a small rig' },
  { size: 3, hint: 'Three well-separated hues' },
  { size: 4, hint: 'The full hand-tuned tetrad' },
];

/**
 * The named looks the auto show picks from, offered by hand.
 *
 * Building four slots that sit together out of twenty-four swatches is the
 * fiddly part of driving the rig manually, and the generated show already had a
 * bank of answers. One press writes all four slots; the size picks which bank,
 * and a palette smaller than four wraps to fill every slot.
 */
function PaletteRow({ palettes, active, presets }) {
  const [size, setSize] = useState(() => {
    const saved = parseInt(localStorage.getItem('lightshow.paletteSize'), 10);
    return saved === 2 || saved === 3 ? saved : 4;
  });
  useEffect(() => { localStorage.setItem('lightshow.paletteSize', String(size)); }, [size]);

  if (!palettes.length) return null;

  const swatchBg = (i) => {
    const c = presets[i];
    if (!c) return '#333';
    return c.name === 'Blackout' ? '#111' : colorToCss(c);
  };

  return (
    <div class="palette-picker">
      <div class="palette-head">
        <span class="palette-title" id="manual-palette-label">Palettes</span>
        <div class="segmented" role="group" aria-labelledby="manual-palette-label">
          {PALETTE_SIZES.map(({ size: n, hint }) => (
            <button
              key={n}
              type="button"
              class={`segmented-btn ${size === n ? 'active' : ''}`}
              aria-pressed={size === n}
              title={hint}
              onClick={() => {
                setSize(n);
                // Live, when a look is already on stage: "same palette, two
                // colours". With nothing selected the server leaves the slots
                // alone and this only sets what the next press will use.
                if (active) send({ paletteSize: n });
              }}
            >{n}</button>
          ))}
        </div>
      </div>

      <div class="palette-grid">
        {palettes.map((p) => {
          const colors = (p.colors && p.colors[size]) || [];
          return (
            <button
              key={p.id}
              type="button"
              class={`palette-btn ${active === p.id ? 'active' : ''}`}
              aria-pressed={active === p.id}
              title={`${p.name} — writes all four slots`}
              onClick={() => send({ palette: p.id, paletteSize: size })}
            >
              <span class="palette-swatches">
                {colors.map((idx, i) => (
                  <span key={i} class="palette-swatch" style={{ background: swatchBg(idx) }} />
                ))}
              </span>
              <span class="palette-name">{p.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The slot a Shift-click (or right-click) writes to instead: A↔B, C↔D. */
function pairedSlot(slot) {
  return slot === 'colorA' ? 'colorB'
    : slot === 'colorB' ? 'colorA'
      : slot === 'colorC' ? 'colorD' : 'colorC';
}

export function Colors() {
  const s = stateSig.value;
  const presets = s.colorPresets || [];
  const [activeSlot, setActiveSlot] = useState('colorA');
  // Roving tabindex: the grid is one stop in the tab order and the arrow keys
  // move within it, rather than twenty-four stops between the slot tabs and
  // everything below them.
  const [focusIdx, setFocusIdx] = useState(0);
  const gridRef = useRef(null);

  if (presets.length === 0) return null;

  const swatchBg = (c) => (c.name === 'Blackout' ? '#111' : colorToCss(c));
  const slotIndex = (k) => s[k];
  const slotPreset = (k) => {
    const i = slotIndex(k);
    return i != null && presets[i] ? presets[i] : null;
  };

  return (
    <div class="card">
      <div class="card-title">Colours</div>

      <PaletteRow palettes={s.palettes || []} active={s.palette || null} presets={presets} />

      {/* Which slot the grid below writes into. Not a tablist: there is one
          shared grid rather than a panel per slot, and declaring tabs without
          panels or arrow-key navigation described a pattern that was not here. */}
      <div class="color-slot-tabs" role="group" aria-label="Active colour slot">
        {SLOTS.map((slot) => {
          const preset = slotPreset(slot.key);
          const sw = preset ? swatchBg(preset) : '#333';
          return (
            <button
              key={slot.key}
              type="button"
              aria-pressed={activeSlot === slot.key}
              class={`color-slot-tab ${activeSlot === slot.key ? 'active' : ''}`}
              style={{ '--slot-color': slot.cssVar, '--swatch': sw }}
              onClick={() => setActiveSlot(slot.key)}
              title={preset ? `Slot ${slot.label}: ${preset.name}` : `Slot ${slot.label}`}
            >
              <span>SLOT {slot.label}</span>
              <span class="swatch" />
            </button>
          );
        })}
      </div>

      {/* swatch grid */}
      <div
        class="color-grid"
        role="group"
        aria-label="Colour presets"
        ref={gridRef}
        onKeyDown={(e) => {
          // The grid is laid out by CSS, so the row width is read back from it
          // rather than assumed here — a breakpoint that changes the column
          // count must not leave Up and Down jumping the wrong distance.
          let cols = 7;
          if (gridRef.current) {
            const tracks = getComputedStyle(gridRef.current).gridTemplateColumns;
            const n = tracks ? tracks.split(' ').filter(Boolean).length : 0;
            if (n > 0) cols = n;
          }
          const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
          let next;
          if (e.key in step) next = focusIdx + step[e.key];
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = presets.length - 1;
          else return;
          e.preventDefault();
          next = Math.max(0, Math.min(presets.length - 1, next));
          setFocusIdx(next);
          gridRef.current?.querySelector(`[data-swatch="${next}"]`)?.focus();
        }}
      >
        {presets.map((c, i) => {
          const isBlackout = c.name === 'Blackout';
          const bg = swatchBg(c);
          const cls = [
            'color-swatch',
            i === s.colorA ? 'active-a' : '',
            i === s.colorB ? 'active-b' : '',
            i === s.colorC ? 'active-c' : '',
            i === s.colorD ? 'active-d' : '',
          ].filter(Boolean).join(' ');
          // Shift writes to the opposite-pair slot for fast two-handed work.
          // A keyboard activation carries shiftKey just as a click does, so
          // Shift+Enter reaches the same place without a separate branch.
          const write = (e) => send({ [e.shiftKey ? pairedSlot(activeSlot) : activeSlot]: i });
          const onContextMenu = (e) => {
            e.preventDefault();
            send({ [pairedSlot(activeSlot)]: i });
          };
          // Colour alone carries which slots a swatch is in, so the label has
          // to say it — and say where pressing it would land.
          const held = SLOTS.filter((sl) => s[sl.key] === i).map((sl) => sl.label);
          const target = SLOTS.find((sl) => sl.key === activeSlot)?.label;
          return (
            <button
              key={i}
              type="button"
              data-swatch={i}
              class={cls}
              title={c.name}
              tabIndex={i === focusIdx ? 0 : -1}
              aria-label={`${c.name}${held.length ? `, in slot ${held.join(' and ')}` : ''}. Write to slot ${target}.`}
              style={{ background: bg, ...(isBlackout ? { border: '2px dashed rgba(255,255,255,.15)' } : {}) }}
              onFocus={() => setFocusIdx(i)}
              onClick={write}
              // Enter and Space already activate a button, but whether the
              // click a browser synthesises from that carries shiftKey is not
              // worth depending on. Read the modifier here and suppress the
              // default activation so the write happens exactly once.
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                send({ [e.shiftKey ? pairedSlot(activeSlot) : activeSlot]: i });
              }}
              onContextMenu={onContextMenu}
            />
          );
        })}
      </div>

      {/* current slot summary */}
      <div class="color-current">
        <div
          style={{
            width: '24px', height: '24px', borderRadius: '6px',
            background: slotPreset(activeSlot) ? swatchBg(slotPreset(activeSlot)) : '#333',
            border: '1px solid rgba(255,255,255,.15)',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700 }}>
            Slot {SLOTS.find((sl) => sl.key === activeSlot)?.label}
          </div>
          <div class="name">{slotPreset(activeSlot)?.name || '—'}</div>
        </div>
      </div>

      <div class="color-hint">
        Click a swatch to write into the active slot.
        <kbd>Shift</kbd> + click → paired slot. Right-click → paired slot.
        Arrow keys move within the grid; <kbd>Shift</kbd> + <kbd>Enter</kbd> writes to the paired slot.
        A palette writes all four at once; editing a slot afterwards drops the name.
      </div>
    </div>
  );
}
