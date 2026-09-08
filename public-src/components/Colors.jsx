import { useState, useEffect } from 'preact/hooks';
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

export function Colors() {
  const s = stateSig.value;
  const presets = s.colorPresets || [];
  const [activeSlot, setActiveSlot] = useState('colorA');

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

      {/* slot tabs */}
      <div class="color-slot-tabs" role="tablist">
        {SLOTS.map((slot) => {
          const preset = slotPreset(slot.key);
          const sw = preset ? swatchBg(preset) : '#333';
          return (
            <button
              key={slot.key}
              role="tab"
              aria-selected={activeSlot === slot.key}
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
      <div class="color-grid">
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
          const onClick = (e) => {
            // shortcut: shift writes to opposite-pair slot for fast two-handed work
            const slot = e.shiftKey
              ? (activeSlot === 'colorA' ? 'colorB' : activeSlot === 'colorB' ? 'colorA'
                : activeSlot === 'colorC' ? 'colorD' : 'colorC')
              : activeSlot;
            send({ [slot]: i });
          };
          const onContextMenu = (e) => {
            e.preventDefault();
            // right-click cycles to the next slot ordering: A→B, B→A, C→D, D→C
            const slot = activeSlot === 'colorA' ? 'colorB'
              : activeSlot === 'colorB' ? 'colorA'
              : activeSlot === 'colorC' ? 'colorD' : 'colorC';
            send({ [slot]: i });
          };
          return (
            <div
              key={i}
              class={cls}
              title={c.name}
              style={{ background: bg, ...(isBlackout ? { border: '2px dashed rgba(255,255,255,.15)' } : {}) }}
              onClick={onClick}
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
        A palette writes all four at once; editing a slot afterwards drops the name.
      </div>
    </div>
  );
}
