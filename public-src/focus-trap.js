import { useEffect } from 'preact/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog's focus, while `active`: it moves into the dialog, Tab and
 * Shift+Tab go round inside it rather than out to the page behind, Escape
 * calls `onClose`, and when it closes focus goes back to where it was — the
 * button that opened it, usually — rather than to the top of the page.
 */
export function useFocusTrap(ref, active, onClose) {
  useEffect(() => {
    const box = ref.current;
    if (!active || !box) return undefined;
    const before = document.activeElement;
    const items = () => [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    (items()[0] || box).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus();
    };
  }, [active]);
}
