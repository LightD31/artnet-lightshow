/**
 * The live rig as lights (see src/shared/rig.js), built from the patch and the
 * profile registry and kept until either changes.
 *
 * Rebuilt on what the rig depends on rather than on an explicit "the patch
 * changed" call: fixtures are edited from sockets, routes, show loads and
 * tests, and a cache that relied on every one of them remembering to say so
 * would sooner or later render a bar with last week's cells. Comparing a
 * short signature once a frame costs a few microseconds.
 */

import { state } from './state.ts';
import { getProfile, profilesRevision } from './profiles.ts';
import { buildRig, rigSignature } from '../shared/rig.ts';
import type { Rig } from '../shared/rig.ts';
import type { Fixture } from '../types/rig.ts';

let cached: Rig<Fixture> | null = null;
let cachedKey = '';

/** The rig as it stands now. */
function currentRig(): Rig<Fixture> {
  const key = rigSignature(state.fixtures, profilesRevision());
  if (!cached || key !== cachedKey || cached.fixtures !== state.fixtures) {
    cached = buildRig(state.fixtures, getProfile);
    cachedKey = key;
  }
  return cached;
}

/** Forget the cached rig, so the next frame builds it afresh. */
function invalidateRig(): void {
  cached = null;
}

export {
  currentRig,
  invalidateRig,
};
