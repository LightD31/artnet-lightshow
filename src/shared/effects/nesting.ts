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

/** A container's child playing now and the beat it is anchored on. */
export interface PlayingChild { spec: EffectSpec; anchorBeat: number }
/** The children a container plays at `beatPos` when anchored on `anchorBeat`, highest first, over `fixtureIds`. */
export type ChildrenAt = (params: unknown, beatPos: number, anchorBeat: number, fixtureIds: readonly (number | string)[]) => PlayingChild[];

const childrenAt = new Map<string, ChildrenAt>();

/** Each container kind answers with the same phase functions it renders with. */
export function registerChildren(kind: string, fn: ChildrenAt): void {
  childrenAt.set(kind, fn);
}

/**
 * The effects playing inside `spec` at `beatPos`, containers resolved to
 * their leaves, highest first; a plain effect is its own leaf. Pure: no
 * state, no dice. Past the nesting limit nothing plays, as validation allows none.
 */
export function playingLeaves(spec: EffectSpec, beatPos: number, anchorBeat: number, fixtureIds: readonly (number | string)[], depth = 0): EffectSpec[] {
  const children = childrenAt.get(spec.kind);
  if (!children) return [spec];
  if (depth >= MAX_NEST_DEPTH) return [];
  return children(spec.params, beatPos, anchorBeat, fixtureIds)
    .flatMap((c) => playingLeaves(c.spec, beatPos, c.anchorBeat, fixtureIds, depth + 1));
}
