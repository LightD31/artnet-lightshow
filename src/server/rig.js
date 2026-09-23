'use strict';

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

const { state } = require('./state');
const { getProfile, profilesRevision } = require('./profiles');
const { buildRig } = require('../shared/rig');

let cached = null;
let cachedKey = '';

function signature() {
  let key = `${profilesRevision()}|${state.fixtures.length}`;
  for (const f of state.fixtures) {
    const p = f.position;
    const g = f.geometry;
    key += `|${f.profileId};${p ? `${p.x},${p.y}` : ''};${f.group || ''};${g ? `${g.length},${g.angle}` : ''}`;
  }
  return key;
}

/** The rig as it stands now. */
function currentRig() {
  const key = signature();
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

module.exports = { currentRig, invalidateRig };
