'use strict';

/**
 * The rig as the pattern layer sees it: fixtures, and the cells inside them.
 *
 * A par is one light. An LED bar is eight or sixteen, each with its own red,
 * green and blue channels, and a look only uses a bar properly when every one
 * of them can be a different colour. A profile says so with `cells`: one
 * channel map per cell, in the order the cells sit along the bar, beside the
 * fixture-level `channelMap` that keeps the channels the whole bar shares (a
 * master dimmer, a strobe). A profile without `cells` is one cell — its
 * channel map is the fixture's — which is every profile that existed before.
 *
 * Browser-safe: the server's engine and the rehearsal preview in the browser
 * both build their picture of the rig from here.
 */

// The channels that make light. A cell is only a cell if it has one of them.
const EMITTERS = ['red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite'];

// How a pixel effect is laid over the cells: across the whole stage, along each
// bar on its own, or mirrored about the centre of the stage.
const PIXEL_MAPS = ['stage', 'bar', 'mirror'];

// A universe holds 170 three-channel cells; no single fixture has more.
const MAX_CELLS_PER_FIXTURE = 170;

/** The profile's cells, or null for a fixture that is one light. */
function cellsOf(profile) {
  const cells = profile && profile.cells;
  return Array.isArray(cells) && cells.length >= 2 ? cells : null;
}

/** How many lights a fixture on this profile is: its cells, or one. */
function unitCount(profile) {
  const cells = cellsOf(profile);
  return cells ? cells.length : 1;
}

/** How many lights a patch is in total. */
function countUnits(fixtures, profileOf) {
  let total = 0;
  for (const fixture of fixtures) total += unitCount(profileOf(fixture));
  return total;
}

module.exports = {
  EMITTERS,
  PIXEL_MAPS,
  MAX_CELLS_PER_FIXTURE,
  cellsOf,
  unitCount,
  countUnits,
};
