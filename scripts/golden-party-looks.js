// Regenerate fixtures only for intentional visual changes so golden checks cannot silently bless regressions.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRenderer } from '../src/server/renderer.ts';
import * as universes from '../src/server/universes.ts';
import { getProfile, profilesRevision, BUILTIN_PROFILE_ID } from '../src/server/profiles.ts';

export const LOOKS = ['position-chase', 'radial-pulse', 'spatial-wash', 'bounce-scan', 'streak', 'starlight', 'breathe', 'volume-gate', 'confetti',
  'anchor-fill', 'halves', 'flip', 'room-wave', 'ring-strobe', 'ring-backlit', 'fireworks', 'flashes', 'swirl'];

export const BEATS = [0, 0.5, 1.25, 3, 7.5];

const BPM = 120;
const MS_PER_BEAT = 60000 / BPM;
const PAR_FOOTPRINT = 12;

function par(id, position) {
  return {
    id, address: 1 + id * PAR_FOOTPRINT, universe: 0, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255,
    override: null, position, group: null, geometry: null, hue: false,
  };
}

export function flatRig() {
  return [0, 1, 2, 3].map((id) => par(id, null));
}

export function placedRig() {
  const across = [10, 37, 63, 90];
  return [
    ...across.map((x, i) => par(i, { x, y: 10 })),
    ...across.map((x, i) => par(4 + i, { x, y: 90 })),
  ];
}

export function renderLookBytes(id, fixtures, effectOf = null) {
  const last = Math.max(...fixtures.map((f) => f.address - 1 + getProfile(f).channelCount));
  const input = {
    running: true, pattern: id, colorA: 0, colorB: 6, colorC: 4, colorD: 8, beatDivision: 1,
    split: null, pixelMap: 'stage', strobeSpeed: 0, strobeFunction: 'standard',
    masterDimmer: 255, masterBlackout: false, energy: null, showDynamics: null, patternAnchor: null,
    fade: null, syncTest: null, universes: [0], fixtures,
    ...(effectOf ? { effect: effectOf(id) } : {}),
  };
  // Reuse one renderer so later samples retain the running show’s original step anchor.
  const renderer = createRenderer({ profileOf: getProfile, profilesRevision, now: 0 });
  const store = universes.createUniverseStore(universes.allocateShared());
  return BEATS.map((beatPos) => {
    renderer.frame(input, { beatPos, bpm: BPM, epoch: 0 }, beatPos * MS_PER_BEAT, store);
    return Array.from(store.getBuffer(0).subarray(0, last));
  });
}

function capture(fixtures) {
  const looks = LOOKS.map((id) => {
    const rows = renderLookBytes(id, fixtures).map((bytes) => `    ${JSON.stringify(bytes)}`);
    return `  ${JSON.stringify(id)}: [\n${rows.join(',\n')}\n  ]`;
  });
  return `{\n${looks.join(',\n')}\n}\n`;
}

function main() {
  const dir = new URL('../tests/fixtures/golden/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(new URL('party-looks-flat.json', dir), capture(flatRig()));
  fs.writeFileSync(new URL('party-looks-placed.json', dir), capture(placedRig()));
}

// Imported by the golden test, which must never rewrite what it checks.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
