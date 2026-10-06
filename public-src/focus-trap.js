import { useEffect } from 'preact/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open traps, innermost last: only that one acts.
const open = [];

const focusables = (box) => [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

/** Escape closes; Tab and Shift+Tab go round inside the box, also when focus has fallen out of it. */
export function trapKey(e, box, onClose, doc = document) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    onClose();
    return;
  }
  if (e.key !== 'Tab') return;
  const list = focusables(box);
  if (!list.length) { e.preventDefault(); box.focus(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = doc.activeElement;
  const inside = box.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/** Focus that lands outside the box goes back to its first control. */
export function trapFocusIn(e, box) {
  if (box.contains(e.target)) return;
  (focusables(box)[0] || box).focus();
}

/**
 * A modal dialog's focus, while `active`: it moves into the dialog, Tab and
 * Shift+Tab go round inside it rather than out to the page behind, Escape
 * calls `onClose`, and when it closes focus goes back to where it was — the
 * button that opened it, usually — rather than to the top of the page.
 * The keys are heard on the document, so they still work after the focused
 * control disappears or is disabled and focus falls to the page.
 */
export function useFocusTrap(ref, active, onClose) {
  useEffect(() => {
    const box = ref.current;
    if (!active || !box) return undefined;
    const before = document.activeElement;
    const entry = { box };
    open.push(entry);
    const top = () => open[open.length - 1] === entry;
    const onKey = (e) => { if (top()) trapKey(e, box, onClose); };
    const onFocusIn = (e) => { if (top()) trapFocusIn(e, box); };
    (focusables(box)[0] || box).focus();
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      open.splice(open.indexOf(entry), 1);
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus();
    };
  }, [active]);
}
