'use strict';

const { COLOR_PRESETS } = require('./presets');

/**
 * Named colour looks, shared by the auto show and manual mode.
 *
 * These banks used to live inside auto-show.js, where only the generated show
 * could reach them. They are the same thing an operator wants by hand — a set
 * of colours that were picked to sit together — so they moved here and manual
 * mode picks from the same list. One bank per palette size, keyed identically,
 * so a look means the same thing whether you ask for two colours or four.
 *
 * Colour preset indices (see presets.js COLOR_PRESETS):
 *    0=Red  1=Amber  2=Lime  3=Green  4=Cyan  5=Blue  6=Congo Blue  7=Violet
 *    8=Magenta  9=Warm White  10=Cool White  11=Lavender  12=Moonlight
 *   13=UV  14=Blackout
 *
 * ── How a look is built ─────────────────────────────────────────────────────
 *
 * Every tetrad is four slots with four different jobs, in this order:
 *
 *   A  dominant — the colour the look is named for; the one most on stage
 *   B  contrast — its opposite. A and B carry `split`, `alt-halves` and the
 *                 two-colour chases, so this pair has to survive being the
 *                 only two colours in the room
 *   C  accent   — a third well-separated hue for the 3- and 4-colour patterns
 *   D  lift     — a white, a pale wash or UV. Not a fourth hue: without a
 *                 brightness break, a four-colour chase reads as a rainbow
 *                 rather than as a look
 *
 * The rule that keeps the banks honest: no two *saturated* entries in one look
 * sit within ~30° of each other. Old looks broke this constantly — `noirUv`
 * paired a 260° "actinic" with a 251° indigo, and `violetDream` was three
 * purples and a white — which is why so many of them read as one colour and a
 * bit of noise. Where a look does hold two colours from the same family they
 * are on different saturation tiers on purpose (`violetDream`'s violet under a
 * pale lavender), which the eye reads as depth rather than as a repeat.
 */

// ── Tetrads (4 colours) ─────────────────────────────────────────────────────
// [dominant, contrast, accent, lift] — see the note above.
const TETRADS = {
  synthwave:   [8, 4, 6, 12],  // Magenta / Cyan / Congo / Moonlight — the neon pair, cooled off
  sunsetDrive: [1, 6, 8, 9],   // Amber / Congo / Magenta / Warm White — last light against night sky
  solarPunch:  [0, 5, 2, 10],  // Red / Blue / Lime / Cool White — a primary triad, maximum separation
  deepOcean:   [4, 6, 3, 12],  // Cyan / Congo / Green / Moonlight — cool analogous with depth
  emeraldCity: [3, 8, 1, 9],   // Green / Magenta / Amber / Warm White — complements plus gold
  arctic:      [10, 6, 4, 12], // Cool White / Congo / Cyan / Moonlight — ice, anchored on white
  violetDream: [7, 4, 1, 11],  // Violet / Cyan / Amber / Lavender — near-triad, purple over its own tint
  volcanic:    [0, 6, 1, 9],   // Red / Congo / Amber / Warm White — fire against a cold sky
  candyPop:    [8, 2, 4, 10],  // Magenta / Lime / Cyan / Cool White — evenly spaced, nothing subtle
  halloween:   [1, 7, 2, 13],  // Amber / Violet / Lime / UV — pumpkin, purple, toxic green
  noirUv:      [13, 10, 6, 12],// UV / Cool White / Congo / Moonlight — dark room, hard white slash
  desert:      [1, 12, 0, 9],  // Amber / Moonlight / Red / Warm White — heat under a bleached sky
  royal:       [7, 1, 5, 9],   // Violet / Amber / Blue / Warm White — purple and gold
  tropical:    [4, 1, 2, 10],  // Cyan / Amber / Lime / Cool White — sea, sun, palms
  aurora:      [3, 7, 4, 12],  // Green / Violet / Cyan / Moonlight — the actual northern-lights hues
  lunar:       [12, 9, 11, 10],// Moonlight / Warm White / Lavender / Cool White — the pale look
};

// ── Triads (3 colours) ──────────────────────────────────────────────────────
// Mostly [dominant, contrast, accent] — the lift is what a third lamp can
// least afford to spend itself on. `desert` and `lunar` keep a pale entry
// because that *is* their look.
const TRIADS = {
  synthwave:   [8, 4, 6],     // Magenta / Cyan / Congo
  sunsetDrive: [1, 6, 8],     // Amber / Congo / Magenta
  solarPunch:  [0, 5, 2],     // Red / Blue / Lime
  deepOcean:   [4, 6, 3],     // Cyan / Congo / Green
  emeraldCity: [3, 8, 1],     // Green / Magenta / Amber
  arctic:      [10, 6, 4],    // Cool White / Congo / Cyan
  violetDream: [7, 4, 1],     // Violet / Cyan / Amber
  volcanic:    [0, 6, 1],     // Red / Congo / Amber
  candyPop:    [8, 2, 4],     // Magenta / Lime / Cyan
  halloween:   [1, 7, 2],     // Amber / Violet / Lime
  noirUv:      [13, 10, 6],   // UV / Cool White / Congo
  desert:      [1, 12, 0],    // Amber / Moonlight / Red
  royal:       [7, 1, 5],     // Violet / Amber / Blue
  tropical:    [4, 1, 2],     // Cyan / Amber / Lime
  aurora:      [3, 7, 4],     // Green / Violet / Cyan
  lunar:       [12, 9, 11],   // Moonlight / Warm White / Lavender
};

// ── Duos (2 colours) ────────────────────────────────────────────────────────
// Two lamps means the pair *is* the look, so every duo is a complementary or
// near-complementary split — nothing under about 70° apart, or else a hard
// tier contrast (`arctic` puts white against a deep blue). A few reach for a
// colour the tetrad does not use — `desert` takes Blue rather than its pale
// Moonlight, `royal` drops to two of its four — because a tint cannot hold up
// half a rig on its own.
const DUOS = {
  synthwave:   [8, 4],        // Magenta / Cyan
  sunsetDrive: [1, 6],        // Amber / Congo
  solarPunch:  [0, 5],        // Red / Blue
  deepOcean:   [4, 6],        // Cyan / Congo
  emeraldCity: [3, 8],        // Green / Magenta
  arctic:      [10, 6],       // Cool White / Congo
  violetDream: [7, 4],        // Violet / Cyan
  volcanic:    [0, 6],        // Red / Congo
  candyPop:    [8, 2],        // Magenta / Lime
  halloween:   [1, 7],        // Amber / Violet
  noirUv:      [13, 10],      // UV / Cool White
  desert:      [1, 5],        // Amber / Blue
  royal:       [7, 9],        // Violet / Warm White
  tropical:    [4, 1],        // Cyan / Amber
  aurora:      [3, 7],        // Green / Violet
  lunar:       [12, 9],       // Moonlight / Warm White
};

/** Look up the right bank for a palette size. 4 is the default. */
function paletteBankForSize(size) {
  if (size === 2) return DUOS;
  if (size === 3) return TRIADS;
  return TETRADS;
}

// Display names for the picker. The bank keys are camelCase identifiers; these
// are what the operator reads on the button.
const PALETTE_NAMES = {
  synthwave:   'Synthwave',
  sunsetDrive: 'Sunset Drive',
  solarPunch:  'Solar Punch',
  deepOcean:   'Deep Ocean',
  emeraldCity: 'Emerald City',
  arctic:      'Arctic',
  violetDream: 'Violet Dream',
  volcanic:    'Volcanic',
  candyPop:    'Candy Pop',
  halloween:   'Halloween',
  noirUv:      'Noir UV',
  desert:      'Desert',
  royal:       'Royal',
  tropical:    'Tropical',
  aurora:      'Aurora',
  lunar:       'Lunar',
};

/**
 * The catalogue the UI and the MIDI binding picker render: one entry per look,
 * carrying the colours it resolves to at each size so a client can draw the
 * swatches without knowing the banks.
 */
const PALETTES = Object.keys(TETRADS).map((id) => ({
  id,
  name: PALETTE_NAMES[id] || id,
  colors: { 2: DUOS[id], 3: TRIADS[id], 4: TETRADS[id] },
}));

const PALETTE_IDS = PALETTES.map((p) => p.id);

/**
 * The colour-preset indices for one look at one size, or null when the id is
 * not a look we know. Indices are clamped to the preset table so a bank entry
 * can never hand out something the engine would read past the end of.
 */
function paletteColors(id, size = 4) {
  const bank = paletteBankForSize(size);
  const raw = bank[id];
  if (!Array.isArray(raw) || !raw.length) return null;
  const maxIdx = COLOR_PRESETS.length - 1;
  return raw.map((i) => Math.max(0, Math.min(maxIdx, i)));
}

/**
 * The four colour slots a look fills.
 *
 * A palette smaller than four slots wraps: a duo becomes A/B/A/B, a triad
 * A/B/C/A. That keeps every pattern usable — the four-colour patterns still
 * have something in every slot — while the look stays the two or three colours
 * that were chosen to sit together.
 */
function paletteSlots(id, size = 4) {
  const colors = paletteColors(id, size);
  if (!colors) return null;
  return {
    colorA: colors[0 % colors.length],
    colorB: colors[1 % colors.length],
    colorC: colors[2 % colors.length],
    colorD: colors[3 % colors.length],
  };
}

module.exports = {
  TETRADS,
  TRIADS,
  DUOS,
  PALETTES,
  PALETTE_IDS,
  PALETTE_NAMES,
  paletteBankForSize,
  paletteColors,
  paletteSlots,
};
