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

import { state } from './state.js';
import { getProfile, profilesRevision } from './profiles.js';
import { buildRig, rigSignature } from '../shared/rig.js';

let cached = null;
let cachedKey = '';

/** The rig as it stands now. */
function currentRig() {
  const key = rigSignature(state.fixtures, profilesRevision());
  if (!cached || key !== cachedKey || cached.fixtures !== state.fixtures) {
    cached = buildRig(state.fixtures, getProfile);
    cachedKey = key;
  }
  return cached;
}

/** Forget the cached rig, so the next frame builds it afresh. */
function invalidateRig() {
  cached = null;
}

export {
  currentRig,
  invalidateRig,
};
