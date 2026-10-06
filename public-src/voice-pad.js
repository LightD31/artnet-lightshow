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
 * goes away lets go by itself. A hold ends when its pointer or key lets go
 * anywhere in the window, whatever happened to its button meanwhile, when
 * its pad is no longer shown as a hold pad, when the socket drops, and when
 * the window loses focus or the page is hidden. A long press on a tap pad
 * opens its editor.
 */
export const LONG_PRESS_MS = 500;

export const padKey = (bank, slot) => `p${bank}-${slot}`;

/** Whether a pad plays while held: hold pads and the strobe. */
export const holdsWhilePressed = (entry) => entry.launch === 'hold' || entry.content?.kind === 'strobe';

/**
 * Whether a pad needs the photosensitivity acknowledgement: the strobe, or
 * content the catalogue (`patterns`) or the saved presets (`effects`) mark
 * rapidFlash. Anything else is left to the server, which refuses with 409.
 */
export function rapidPad(entry, patterns = [], effects = []) {
  const content = entry.content;
  if (!content) return false;
  if (content.kind === 'strobe') return true;
  const rows = content.kind === 'preset' ? [...(effects || []), ...(patterns || [])] : content.kind === 'pattern' ? patterns || [] : [];
  return !!rows.find((r) => r.id === content.id)?.rapidFlash;
}

/**
 * One set of pads' presses over `holds` (createVoiceHolds), kept out of
 * Preact so it can be tested. `win` gets the pointerup, pointercancel and
 * keyup listeners; `onChange` gets the held keys whenever they change.
 */
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
  // A hold dropped elsewhere (a disconnect, a refused press) unlights here.
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
    /** Lets go of every press whose key is not in `keys`, the pads shown as hold pads. */
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
  // The keys this render shows as hold pads; anything else held lets go.
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

  /** Handlers for a button that runs `target` while held. */
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
    };
  };

  /** A tap on a once or loop pad. */
  const tap = (entry) => api(`/api/pads/${entry.bank}/${entry.slot}/${entry.launch === 'loop' ? 'toggle' : 'once'}`, { method: 'POST' });

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
        tap(entry);
      },
      onContextMenu: (e) => e.preventDefault(),
    };
  };

  /**
   * padProps behind the safety gate (useSafetyGate): before the
   * acknowledgement a rapid pad asks instead; a tap pad then plays, a hold
   * pad holds on the next press.
   */
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
