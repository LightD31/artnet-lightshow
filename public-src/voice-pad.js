import { useEffect, useRef, useState } from 'preact/hooks';
import { api, voiceHolds } from './state.js';
import { focusedByPointer } from './focus-origin.js';

/**
 * Pads on buttons: the Perform deck, the command bar's strip and the strobe
 * pad share this, so a pad plays the same wherever it is.
 *
 *   hold   runs while held — a pointer pressed on it (captured, so sliding
 *          off does not drop it), or Space or Enter held down on it
 *   once   a tap plays it once; the server ends it
 *   loop   a tap starts it, the next tap stops it
 *
 * A hold is renewed with the server while it lasts (hold-control.js), each
 * pad under its own token, so several can be held at once and a page that
 * goes away lets go by itself. Holds also let go when the window loses focus
 * or the page is hidden. A long press on a tap pad opens its editor.
 */
export const LONG_PRESS_MS = 500;

export const padKey = (bank, slot) => `p${bank}-${slot}`;

/** Whether a pad plays while held: hold pads and the strobe. */
export const holdsWhilePressed = (entry) => entry.launch === 'hold' || entry.content?.kind === 'strobe';

export function useVoicePads({ onLongPress } = {}) {
  const [held, setHeld] = useState(() => new Set());
  const pressRef = useRef(new Map());
  const timer = useRef(null);
  const longPressed = useRef(false);

  const mark = () => setHeld(new Set(pressRef.current.keys()));
  const release = (key) => {
    if (!pressRef.current.has(key)) return;
    pressRef.current.delete(key);
    voiceHolds.release(key);
    mark();
  };
  const releaseAll = () => { for (const key of [...pressRef.current.keys()]) release(key); };

  useEffect(() => {
    const hidden = () => { if (document.hidden) releaseAll(); };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      releaseAll();
      clearTimeout(timer.current);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  const press = (key, target, how) => {
    if (!voiceHolds.press(key, target)) return false;
    pressRef.current.set(key, how);
    mark();
    return true;
  };
  const mine = (key, field, value) => pressRef.current.get(key)?.[field] === value;

  /** Handlers for a button that runs `target` while held. */
  const holdProps = (key, target) => ({
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
      // Space on a pad the pointer last touched is the tap-tempo key.
      if (e.key === ' ' && focusedByPointer(e.currentTarget)) return;
      e.preventDefault();
      if (!e.repeat) press(key, target, { key: e.key });
    },
    onKeyUp: (e) => { if (mine(key, 'key', e.key)) { e.preventDefault(); release(key); } },
    onBlur: () => release(key),
    // A long press must not open the page's context menu mid-show.
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: 'none' },
  });

  /** Handlers for a pad of the layout, as its launch mode says. */
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
        api(`/api/pads/${bank}/${slot}/${entry.launch === 'loop' ? 'toggle' : 'once'}`, { method: 'POST' });
      },
      onContextMenu: (e) => e.preventDefault(),
    };
  };

  return { held, holdProps, padProps, releaseAll };
}
