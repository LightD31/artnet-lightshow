import { useEffect, useRef, useState } from 'preact/hooks';
import { api, voiceHolds } from './state.js';
import { focusedByPointer } from './focus-origin.js';

// Window-level releases prevent stuck holds when a button unmounts or a pointer slides away.
export const LONG_PRESS_MS = 500;

export const padKey = (bank, slot) => `p${bank}-${slot}`;

export const holdsWhilePressed = (entry) => entry.launch === 'hold' || entry.content?.kind === 'strobe';

export function rapidPad(entry, patterns = [], effects = []) {
  const content = entry.content;
  if (!content) return false;
  if (content.kind === 'strobe') return true;
  const rows = content.kind === 'preset' ? [...(effects || []), ...(patterns || [])] : content.kind === 'pattern' ? patterns || [] : [];
  return !!rows.find((r) => r.id === content.id)?.rapidFlash;
}

export function createPadPresses(holds, win, onChange) {
  const presses = new Map();
  const changed = () => onChange(new Set(presses.keys()));
  const release = (key) => {
    if (!presses.delete(key)) return;
    holds.release(key);
    changed();
  };
  const releaseAll = () => { for (const key of [...presses.keys()]) release(key); };
  const releaseBy = (field, value) => { for (const [key, how] of [...presses]) if (how[field] === value) release(key); };
  const pointerEnd = (e) => releaseBy('pointer', e.pointerId);
  const keyUp = (e) => releaseBy('key', e.key);
  const unsubscribe = holds.onEnd((key) => { if (presses.delete(key)) changed(); });
  win.addEventListener('pointerup', pointerEnd, true);
  win.addEventListener('pointercancel', pointerEnd, true);
  win.addEventListener('keyup', keyUp);
  return {
    press(key, target, how) {
      if (!holds.press(key, target)) return false;
      presses.set(key, how);
      changed();
      return true;
    },
    release,
    releaseAll,
    mine: (key, field, value) => presses.get(key)?.[field] === value,
    keep(keys) { for (const key of [...presses.keys()]) if (!keys.has(key)) release(key); },
    dispose() {
      releaseAll();
      unsubscribe();
      win.removeEventListener('pointerup', pointerEnd, true);
      win.removeEventListener('pointercancel', pointerEnd, true);
      win.removeEventListener('keyup', keyUp);
    },
  };
}

export function useVoicePads({ onLongPress } = {}) {
  const [held, setHeld] = useState(() => new Set());
  const presses = useRef(null);
  const timer = useRef(null);
  const longPressed = useRef(false);
  const shown = new Set();

  useEffect(() => {
    const p = createPadPresses(voiceHolds, window, setHeld);
    presses.current = p;
    const hidden = () => { if (document.hidden) p.releaseAll(); };
    window.addEventListener('blur', p.releaseAll);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      presses.current = null;
      p.dispose();
      clearTimeout(timer.current);
      window.removeEventListener('blur', p.releaseAll);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  useEffect(() => { presses.current?.keep(shown); });

  const release = (key) => presses.current?.release(key);
  const releaseAll = () => presses.current?.releaseAll();
  const press = (key, target, how) => !!presses.current?.press(key, target, how);
  const mine = (key, field, value) => !!presses.current?.mine(key, field, value);

  const holdProps = (key, target) => {
    shown.add(key);
    return {
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (press(key, target, { pointer: e.pointerId })) e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerUp: (e) => { if (mine(key, 'pointer', e.pointerId)) release(key); },
      onPointerCancel: (e) => { if (mine(key, 'pointer', e.pointerId)) release(key); },
      onLostPointerCapture: (e) => { if (mine(key, 'pointer', e.pointerId)) release(key); },
      onKeyDown: (e) => {
        if (![' ', 'Enter'].includes(e.key)) return;
        if (e.key === ' ' && focusedByPointer(e.currentTarget)) return;
        e.preventDefault();
        if (!e.repeat) press(key, target, { key: e.key });
      },
      onKeyUp: (e) => { if (mine(key, 'key', e.key)) { e.preventDefault(); release(key); } },
      onBlur: () => release(key),
      // A long press must not open the page's context menu mid-show.
      onContextMenu: (e) => e.preventDefault(),
      style: { touchAction: 'none' },
    };
  };

  const tap = (entry) => api(`/api/pads/${entry.bank}/${entry.slot}/${entry.launch === 'loop' ? 'toggle' : 'once'}`, { method: 'POST' });

  const padProps = (entry) => {
    const { bank, slot } = entry;
    if (!entry.content) return {};
    if (holdsWhilePressed(entry)) return holdProps(padKey(bank, slot), { pad: { bank, slot } });
    const stopTimer = () => clearTimeout(timer.current);
    return {
      onPointerDown: (e) => {
        if (e.button !== 0 || !onLongPress) return;
        longPressed.current = false;
        stopTimer();
        timer.current = setTimeout(() => { longPressed.current = true; onLongPress(entry); }, LONG_PRESS_MS);
      },
      onPointerUp: stopTimer,
      onPointerLeave: stopTimer,
      onPointerCancel: stopTimer,
      onClick: () => {
        if (longPressed.current) { longPressed.current = false; return; }
        tap(entry);
      },
      onContextMenu: (e) => e.preventDefault(),
    };
  };

  // After acknowledgement, hold pads wait for a fresh press so no released gesture starts a hold.
  const gatedPadProps = (entry, gate, rapid, name) => {
    if (!entry.content || !rapid || gate.acknowledged) return padProps(entry);
    return {
      onClick: () => gate.guard(name, holdsWhilePressed(entry) ? () => {} : () => tap(entry)),
      onContextMenu: (e) => e.preventDefault(),
      'data-safety': 'ask',
    };
  };

  return { held, holdProps, padProps, gatedPadProps, releaseAll };
}
