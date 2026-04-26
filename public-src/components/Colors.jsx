import { stateSig, send } from '../state.js';
import { colorToCss } from '../utils.js';

export function Colors() {
  const s = stateSig.value;
  const presets = s.colorPresets || [];
  if (presets.length === 0) return null;

  return (
    <div class="card">
      <div class="card-title">Colours</div>
      <div class="color-grid">
        {presets.map((c, i) => {
          const isBlackout = c.name === 'Blackout';
          const bg = isBlackout ? '#111' : colorToCss(c);
          const cls = [
            'color-swatch',
            i === s.colorA ? 'active-a' : '',
            i === s.colorB ? 'active-b' : '',
            i === s.colorC ? 'active-c' : '',
            i === s.colorD ? 'active-d' : '',
          ].filter(Boolean).join(' ');
          return (
            <div
              key={i}
              class={cls}
              title={c.name}
              style={{ background: bg, ...(isBlackout ? { border: '2px solid #444' } : {}) }}
              onClick={(e) => send(e.shiftKey ? { colorC: i } : { colorA: i })}
              onContextMenu={(e) => { e.preventDefault(); send(e.shiftKey ? { colorD: i } : { colorB: i }); }}
            />
          );
        })}
      </div>
      <div class="color-legend">
        <span class="a">Colour A</span>
        <span class="b">Colour B</span>
        <span class="c">Colour C</span>
        <span class="d">Colour D</span>
      </div>
      <p style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '8px' }}>
        Click = A &nbsp;|&nbsp; Right-click = B &nbsp;|&nbsp; Shift+click = C &nbsp;|&nbsp; Shift+right-click = D
      </p>
    </div>
  );
}
