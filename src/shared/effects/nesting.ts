// One stack counts nesting depth across mixed macro and bundle containers.

import type { EffectSpec } from './types.ts';

export const MAX_NEST_DEPTH = 32;

const open: unknown[] = [];

export function nestRefusal(table: unknown): 'cycle' | 'deep' | null {
  if (open.includes(table)) return 'cycle';
  return open.length >= MAX_NEST_DEPTH ? 'deep' : null;
}

export function withinNest<T>(table: unknown, fn: () => T): T {
  open.push(table);
  try {
    return fn();
  } finally {
    open.pop();
  }
}

let asking = 0;
// Treat over-depth unvalidated children as rapid so cycles cannot bypass admission.
export function anyChildSpec(children: readonly unknown[], test: (spec: EffectSpec) => boolean): boolean {
  if (asking >= MAX_NEST_DEPTH) return true;
  asking++;
  try {
    return children.some((spec) => spec !== null && typeof spec === 'object' && test(spec as EffectSpec));
  } finally {
    asking--;
  }
}

export interface PlayingChild { spec: EffectSpec; anchorBeat: number }
export type ChildrenAt = (params: unknown, beatPos: number, anchorBeat: number, fixtureIds: readonly (number | string)[]) => PlayingChild[];

const childrenAt = new Map<string, ChildrenAt>();

export function registerChildren(kind: string, fn: ChildrenAt): void {
  childrenAt.set(kind, fn);
}

export function playingLeaves(spec: EffectSpec, beatPos: number, anchorBeat: number, fixtureIds: readonly (number | string)[], depth = 0): EffectSpec[] {
  const children = childrenAt.get(spec.kind);
  if (!children) return [spec];
  if (depth >= MAX_NEST_DEPTH) return [];
  return children(spec.params, beatPos, anchorBeat, fixtureIds)
    .flatMap((c) => playingLeaves(c.spec, beatPos, c.anchorBeat, fixtureIds, depth + 1));
}
