import { useEffect, useRef, useState } from 'preact/hooks';
import { energyHold } from './state.js';

/**
 * Energy effects on buttons: the command bar's strip and the Perform view's
 * pads share this, so a pad behaves the same wherever it is.
 *
 *   momentary  the effect runs while the pad is held — a pointer pressed on
 *              it (captured, so sliding off does not drop it), or Space or
 *              Enter held down on it — and stops when it is let go
 *   latched    a tap starts it and the next tap on it stops it; tapping
 *              another effect moves the latch there
 *
 * Either way the page keeps renewing the press with the server while it
 * holds (hold-control.js), so a page that goes away — a closed tab, a tablet
 * that sleeps, a dropped network — lets go by itself. For the same reason
 * the effect is let go when the window loses focus or the page is hidden.
 *
 * Returns `[held, props]`: the id held from here, or null, and a function
 * giving a pad's event handlers.
 */
export function useEnergyPads({ latch = false } = {}) {
  const pressRef = useRef(null);
  const [held, setHeld] = useState(null);

  const release = () => {
    pressRef.current = null;
    energyHold.release();
    setHeld(null);
  };

  useEffect(() => {
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      release();
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  // Switching latch off lets a latched effect go.
  useEffect(() => { if (!latch && pressRef.current?.latched) release(); }, [latch]);

  const press = (id, how) => {
    if (latch && pressRef.current?.id === id) { release(); return false; }
    if (!energyHold.press(id)) return false;
    pressRef.current = { id, ...how, latched: latch };
    setHeld(id);
    return true;
  };

  const props = (id) => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (press(id, { pointer: e.pointerId }) && !latch) e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerUp: (e) => {
      if (!latch && pressRef.current?.id === id && pressRef.current.pointer === e.pointerId) release();
    },
    onPointerCancel: (e) => {
      if (!latch && pressRef.current?.id === id && pressRef.current.pointer === e.pointerId) release();
    },
    onLostPointerCapture: (e) => {
      if (!latch && pressRef.current?.id === id && pressRef.current.pointer === e.pointerId) release();
    },
    onKeyDown: (e) => {
      if (![' ', 'Enter'].includes(e.key)) return;
      // Space on a pad the pointer last touched is the tap-tempo key
      // (CommandBar spaceIsTap), not a press.
      if (e.key === ' ' && !e.currentTarget.matches(':focus-visible')) return;
      e.preventDefault();
      if (!e.repeat) press(id, { key: e.key });
    },
    onKeyUp: (e) => {
      if (!latch && pressRef.current?.id === id && pressRef.current.key === e.key) {
        e.preventDefault();
        release();
      }
    },
    onBlur: () => { if (!latch && pressRef.current?.id === id) release(); },
    // A tap on a touch screen fires no click we need, and a long press must
    // not open the page's context menu mid-show.
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: 'none' },
    'aria-pressed': held === id,
  });

  return [held, props, release];
}
