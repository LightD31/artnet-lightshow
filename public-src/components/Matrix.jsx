import { useEffect, useMemo, useState } from 'preact/hooks';
import { field, api } from '../state.js';
import { createHoldControl } from '../hold-control.js';
import { useSafetyGate } from './Photosensitivity.jsx';
import { matrixAsks } from '../preview-inputs.js';

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
 * the server's lease runs out. A first press the server refuses (409 before
 * the photosensitivity acknowledgement, 400 past eight cells) stops renewing
 * and lets the finger go without a release; `onRefused` hears of it.
 */
export function createMatrixHolds(post, onRefused = () => {}) {
  const page = Math.random().toString(36).slice(2, 8);
  const fingers = new Map();
  const release = (pointerId) => {
    const finger = fingers.get(pointerId);
    if (!finger) return;
    fingers.delete(pointerId);
    finger.control.release();
  };
  const refuse = (pointerId, finger) => {
    finger.refused = true;
    finger.control.release();
    if (fingers.get(pointerId) !== finger) return;
    fingers.delete(pointerId);
    onRefused(pointerId);
  };
  return {
    press(pointerId, colour) {
      release(pointerId);
      const finger = { colour, refused: false };
      finger.control = createHoldControl(({ action, token }) => {
        if (finger.refused) return false;
        const sent = post(action === 'release' ? 'release' : 'press', { colour, token: `${page}-${pointerId}-${token}` }, action);
        if (action === 'press') Promise.resolve(sent).then((r) => { if (r && r.ok === false) refuse(pointerId, finger); });
        return sent !== false;
      });
      fingers.set(pointerId, finger);
      finger.control.press();
    },
    release,
    releaseAll() { for (const id of [...fingers.keys()]) release(id); },
  };
}

// A renewal that fails says nothing: the lease ending is the fallback. A
// press or release goes through api(), which shows the server's error.
function postMatrix(verb, body, action) {
  const init = { method: 'POST', body: JSON.stringify(body) };
  if (action === 'renew') {
    fetch(`/api/matrix/${verb}`, { ...init, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    return true;
  }
  return api(`/api/matrix/${verb}`, init);
}

export function Matrix() {
  const board = field('matrix').value || {};
  // No fallback: until the server says, no mode is chosen.
  const mode = board.mode || null;
  // The server keeps colours in upper case; the cells are lower case.
  const playing = Array.isArray(board.colours) ? board.colours.map((c) => String(c).toLowerCase()) : [];
  const [down, setDown] = useState({});
  const lift = (pointerId) => setDown((d) => {
    const next = { ...d };
    delete next[pointerId];
    return next;
  });
  const holds = useMemo(() => createMatrixHolds(postMatrix, lift), []);
  useEffect(() => {
    const letGo = () => { holds.releaseAll(); setDown({}); };
    window.addEventListener('blur', letGo);
    return () => { window.removeEventListener('blur', letGo); holds.releaseAll(); };
  }, [holds]);

  const gate = useSafetyGate();
  const press = (e, colour) => {
    e.preventDefault();
    // A rapid mode asks first, as the strobe pad does; the next press holds.
    if (matrixAsks(mode, gate.acknowledged)) { gate.guard(`Matrix ${mode}`, () => {}); return; }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    holds.press(e.pointerId, colour);
    setDown((d) => ({ ...d, [e.pointerId]: colour }));
  };
  const release = (e) => {
    holds.release(e.pointerId);
    lift(e.pointerId);
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
      {gate.dialog}
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
