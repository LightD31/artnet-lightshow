import { useEffect } from 'preact/hooks';
import { emitTap } from './state.js';
import { focusedByPointer } from './focus-origin.js';

export function spaceIsTap(target) {
  if (!target || target === document.body || target === document.documentElement) return true;
  if (target.isContentEditable) return false;
  if (target.tagName === 'BUTTON') return focusedByPointer(target);
  if (target.tagName === 'INPUT' && target.type === 'range') return focusedByPointer(target);
  return !(target.tabIndex >= 0 || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export function useTapShortcut() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || !spaceIsTap(e.target)) return;
      e.preventDefault();
      emitTap();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
