import { PaletteStrip } from './PaletteStrip.jsx';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';
import { useState, useRef } from 'preact/hooks';
import { send, pick } from '../state.js';
import { colorToCss } from '../utils.js';

const SLOTS = [
  { key: 'colorA', label: 'A', cssVar: 'var(--accent)' },
  { key: 'colorB', label: 'B', cssVar: 'var(--accent-2)' },
  { key: 'colorC', label: 'C', cssVar: 'var(--accent-3)' },
  { key: 'colorD', label: 'D', cssVar: 'var(--accent-4)' },
];

/** The slot a Shift-click (or right-click) writes to instead: A↔B, C↔D. */
function pairedSlot(slot) {
  return slot === 'colorA' ? 'colorB'
    : slot === 'colorB' ? 'colorA'
      : slot === 'colorC' ? 'colorD' : 'colorC';
}

export function Colors() {
  const s = pick(['colorA', 'colorB', 'colorC', 'colorD', 'colorPresets', 'palette', 'palettes', 'basePalette']);
  const presets = s.colorPresets || [];
  const [activeSlot, setActiveSlot] = useState('colorA');
  // Roving tabindex: the grid is one stop in the tab order and the arrow keys
  // move within it, rather than twenty-four stops between the slot tabs and
  // everything below them.
  const [focusIdx, setFocusIdx] = useState(0);
  const gridRef = useRef(null);

  if (presets.length === 0) return null;

  const swatchBg = (c) => (c.name === 'Blackout' ? '#111' : colorToCss(c));
  const slotColour = (k) => s.basePalette?.colours[SLOTS.findIndex((slot) => slot.key === k) % s.basePalette.colours.length];
  const slotIndex = (k) => slotColour(k) ? presets.findIndex((p) => toHex(p) === slotColour(k)) : s[k];
  const slotPreset = (k) => {
    const i = slotIndex(k);
    return i != null && presets[i] ? presets[i] : slotColour(k) ? { ...parseHex(slotColour(k)), name: slotColour(k) } : null;
  };

  return (
    <div class="card">
      <div class="card-title">Colours</div>

      <PaletteStrip initialTarget="base" />

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
            i === slotIndex('colorA') ? 'active-a' : '',
            i === slotIndex('colorB') ? 'active-b' : '',
            i === slotIndex('colorC') ? 'active-c' : '',
            i === slotIndex('colorD') ? 'active-d' : '',
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
          const held = SLOTS.filter((sl) => slotIndex(sl.key) === i).map((sl) => sl.label);
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
