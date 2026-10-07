// :focus-visible changes on keydown, so record pointer focus before keyboard handlers run.

let pressed = null;

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    pressed = e.target && typeof e.target.closest === 'function' ? e.target.closest('button, input, select, [tabindex]') : null;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') pressed = null;
  }, true);
}

export function focusedByPointer(el) {
  return !!el && el === pressed && el === document.activeElement;
}
