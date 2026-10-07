/**
 * Whether the control with focus got it from a pointer — a click or a tap —
 * rather than from the keyboard.
 *
 * `:focus-visible` looks like the answer and is not: the browser turns it on
 * the moment a key is pressed, so by the time a keydown handler asks, a
 * button that was clicked already matches it. So the page keeps its own
 * note: the control a pointer last pressed, until Tab moves focus on.
 */

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
