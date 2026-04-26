import { useState } from 'preact/hooks';
import { stateSig, send } from '../state.js';
import { colorToCss } from '../utils.js';

const SLOTS = [
  { key: 'colorA', label: 'A', cssVar: 'var(--accent)' },
  { key: 'colorB', label: 'B', cssVar: 'var(--accent-2)' },
  { key: 'colorC', label: 'C', cssVar: 'var(--accent-3)' },
  { key: 'colorD', label: 'D', cssVar: 'var(--accent-4)' },
];

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
      </div>
    </div>
  );
}
