import { useEffect, useMemo, useState } from 'preact/hooks';
import { field, api } from '../state.js';
import { createHoldControl } from '../hold-control.js';

// Light DJ's Matrix Strobe Maker: every colour held down joins one list that
// the board plays in its mode; letting go of the last one stops it. The
// server keeps that one voice; this page only presses and releases colours.

export const MATRIX_MODES = [
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'flashes', label: 'Flashes' },
  { id: 'pulses', label: 'Pulses' },
  { id: 'cycle', label: 'Cycle' },
  { id: 'solid', label: 'Solid' },
];

// A hue wheel in fourteen steps, then warm white and white.
const WHEEL = Array.from({ length: 14 }, (_, i) => hslHex((i * 360) / 14));
export const MATRIX_COLOURS = [...WHEEL, '#ffd9a0', '#ffffff'];

function hslHex(h) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const v = 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * One hold per finger. A hold renews by pressing its colour again under the
 * same token, so a tablet that drops off the Wi-Fi lets the colour go when
 * the server's lease runs out.
 */
export function createMatrixHolds(post) {
  const page = Math.random().toString(36).slice(2, 8);
  const fingers = new Map();
  const release = (pointerId) => {
    const finger = fingers.get(pointerId);
    if (!finger) return;
    fingers.delete(pointerId);
    finger.control.release();
  };
  return {
    press(pointerId, colour) {
      release(pointerId);
      const control = createHoldControl(({ action, token }) =>
        post(action === 'release' ? 'release' : 'press', { colour, token: `${page}-${pointerId}-${token}` }, action));
      fingers.set(pointerId, { control, colour });
      control.press();
    },
    release,
    releaseAll() { for (const id of [...fingers.keys()]) release(id); },
  };
}

// A renewal that fails says nothing: the lease ending is the fallback.
function postMatrix(verb, body, action) {
  const init = { method: 'POST', body: JSON.stringify(body) };
  if (action === 'renew') {
    fetch(`/api/matrix/${verb}`, { ...init, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  } else {
    api(`/api/matrix/${verb}`, init);
  }
  return true;
}

export function Matrix() {
  const board = field('matrix').value || {};
  const mode = board.mode || 'flashes';
  const playing = Array.isArray(board.colours) ? board.colours : [];
  const holds = useMemo(() => createMatrixHolds(postMatrix), []);
  const [down, setDown] = useState({});
  useEffect(() => {
    const letGo = () => { holds.releaseAll(); setDown({}); };
    window.addEventListener('blur', letGo);
    return () => { window.removeEventListener('blur', letGo); holds.releaseAll(); };
  }, [holds]);

  const press = (e, colour) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    holds.press(e.pointerId, colour);
    setDown((d) => ({ ...d, [e.pointerId]: colour }));
  };
  const release = (e) => {
    holds.release(e.pointerId);
    setDown((d) => {
      const next = { ...d };
      delete next[e.pointerId];
      return next;
    });
  };
  const held = new Set([...playing, ...Object.values(down)]);

  return (
    <section class="matrix-view" aria-label="Matrix board">
      <div class="matrix-now" aria-live="polite">
        {playing.length ? `Playing ${playing.length} colour${playing.length > 1 ? 's' : ''} as ${mode}` : 'Hold colours to play them'}
      </div>
      <div class="matrix-modes" role="radiogroup" aria-label="Board mode">
        {MATRIX_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            class={`matrix-mode ${mode === m.id ? 'active' : ''}`}
            onClick={() => api('/api/matrix', { method: 'PUT', body: JSON.stringify({ mode: m.id }) })}
          >{m.label}</button>
        ))}
      </div>
      <div class="matrix-grid" style={{ touchAction: 'none' }}>
        {MATRIX_COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            class={`matrix-cell${held.has(colour) ? ' held' : ''}`}
            aria-label={`Colour ${colour}`}
            aria-pressed={held.has(colour)}
            style={{ background: colour }}
            onPointerDown={(e) => press(e, colour)}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onContextMenu={(e) => e.preventDefault()}
          />
        ))}
      </div>
    </section>
  );
}
