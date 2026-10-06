// Containers (macros, pattern bundles) validate and ask about their children
// on one shared stack, so a macro inside a bundle inside a macro counts every level.

import type { EffectSpec } from './types.ts';

export const MAX_NEST_DEPTH = 32;

// Child tables being validated, outermost first; one met again is a cycle.
const open: unknown[] = [];

/** Why `table` may not open another level: it is already open, or the stack is full; null when it may. */
export function nestRefusal(table: unknown): 'cycle' | 'deep' | null {
  if (open.includes(table)) return 'cycle';
  return open.length >= MAX_NEST_DEPTH ? 'deep' : null;
}

/** Run `fn` with `table` open as one more level. */
export function withinNest<T>(table: unknown, fn: () => T): T {
  open.push(table);
  try {
    return fn();
  } finally {
    open.pop();
  }
}

let asking = 0;
/** Whether any child spec passes `test`; past the limit (an unvalidated cycle) assume yes. */
export function anyChildSpec(children: readonly unknown[], test: (spec: EffectSpec) => boolean): boolean {
  if (asking >= MAX_NEST_DEPTH) return true;
  asking++;
  try {
    return children.some((spec) => spec !== null && typeof spec === 'object' && test(spec as EffectSpec));
  } finally {
    asking--;
  }
}
