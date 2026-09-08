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
 *   0=Crimson 1=Flame 2=Amber 3=Sun 4=Lime 5=Aqua 6=Cobalt 7=Violet 8=Fuchsia
 *   9=Daylight White 10=UV 11=Actinic 12=Rose 13=Teal 14=Gold 15=Tungsten White
 *   16=Mint 17=Sky 18=Indigo 19=Coral 20=Lavender 21=Acid 22=Moonlight
 */

// ── Tetrads (4 colours) ─────────────────────────────────────────────────────
// Hand-tuned for coherence — most follow the tetrad rule (two pairs of
// analogous + complement) or split-complementary (one dominant + two accents).
// Ordering inside each tetrad matters: position 0 is the "anchor" that shows
// up first, positions 1-3 fill out the coherent pairings.
const TETRADS = {
  synthwave:   [8, 6, 12, 11],  // Fuchsia / Cobalt / Rose / Actinic — high-energy club contrast
  sunsetDrive: [1, 19, 8, 15],  // Flame / Coral / Fuchsia / Tungsten White — warm lead with glam accent
  solarPunch:  [3, 2, 14, 6],   // Sun / Amber / Gold / Cobalt — warm dominant + cool counter
  deepOcean:   [5, 13, 6, 17],  // Aqua / Teal / Cobalt / Sky — cool analogous depth
  emeraldCity: [4, 16, 13, 14], // Lime / Mint / Teal / Gold — natural greens with premium warmth
  arctic:      [17, 6, 9, 20],  // Sky / Cobalt / Daylight White / Lavender — icy cinematic look
  violetDream: [7, 20, 8, 9],   // Violet / Lavender / Fuchsia / Daylight White — dreamy purple family
  volcanic:    [0, 1, 14, 15],  // Crimson / Flame / Gold / Tungsten White — aggressive warm concert look
  candyPop:    [12, 8, 3, 5],   // Rose / Fuchsia / Sun / Aqua — playful high-separation tetrad
  halloween:   [1, 7, 14, 10],  // Flame / Violet / Gold / UV — spooky
  noirUv:      [10, 11, 18, 9], // UV / Actinic / Indigo / Daylight White — dark room + UV accent
  desert:      [2, 14, 19, 15], // Amber / Gold / Coral / Tungsten White — earthy warm theatre wash
  royal:       [7, 18, 14, 9],  // Violet / Indigo / Gold / Daylight White — regal stage contrast
  tropical:    [16, 13, 3, 19], // Mint / Teal / Sun / Coral — festival warm/cool crossover
  aurora:      [17, 16, 20, 11],// Sky / Mint / Lavender / Actinic — ethereal atmospheric blend
  lunar:       [9, 15, 6, 18],  // Daylight White / Tungsten White / Cobalt / Indigo — monochrome+cold accents
};

// ── Triads (3 colours) ──────────────────────────────────────────────────────
// Hand-picked — NOT slices of TETRADS — so the 3-colour view stays visually
// coherent (triads favour three well-separated hues instead of the tetrad's two
// analogous pairs). Keys match TETRADS so the same resolver can swap size
// without changing its logic.
const TRIADS = {
  synthwave:   [8, 6, 11],    // Fuchsia / Cobalt / Actinic
  sunsetDrive: [1, 19, 15],   // Flame / Coral / Tungsten White
  solarPunch:  [3, 14, 6],    // Sun / Gold / Cobalt
  deepOcean:   [5, 13, 6],    // Aqua / Teal / Cobalt
  emeraldCity: [4, 16, 14],   // Lime / Mint / Gold
  arctic:      [17, 6, 9],    // Sky / Cobalt / Daylight White
  violetDream: [7, 20, 9],    // Violet / Lavender / Daylight White
  volcanic:    [0, 1, 15],    // Crimson / Flame / Tungsten White
  candyPop:    [12, 3, 5],    // Rose / Sun / Aqua
  halloween:   [1, 7, 10],    // Flame / Violet / UV
  noirUv:      [10, 11, 18],  // UV / Actinic / Indigo
  desert:      [2, 14, 19],   // Amber / Gold / Coral
  royal:       [7, 14, 9],    // Violet / Gold / Daylight White
  tropical:    [16, 13, 19],  // Mint / Teal / Coral
  aurora:      [17, 16, 20],  // Sky / Mint / Lavender
  lunar:       [9, 6, 18],    // Daylight White / Cobalt / Indigo
};

// ── Duos (2 colours) ────────────────────────────────────────────────────────
// Complementary pairs that read cleanly on a small rig — two hand-picked hues
// that contrast strongly instead of the tetrad's analogous pair (which would
// look like a single colour from the audience).
const DUOS = {
  synthwave:   [8, 6],        // Fuchsia / Cobalt
  sunsetDrive: [1, 17],       // Flame / Sky
  solarPunch:  [3, 7],        // Sun / Violet
  deepOcean:   [5, 13],       // Aqua / Teal
  emeraldCity: [4, 14],       // Lime / Gold
  arctic:      [17, 9],       // Sky / Daylight White
  violetDream: [7, 9],        // Violet / Daylight White
  volcanic:    [0, 15],       // Crimson / Tungsten White
  candyPop:    [12, 5],       // Rose / Aqua
  halloween:   [1, 10],       // Flame / UV
  noirUv:      [10, 11],      // UV / Actinic
  desert:      [2, 6],        // Amber / Cobalt
  royal:       [7, 14],       // Violet / Gold
  tropical:    [16, 19],      // Mint / Coral
  aurora:      [16, 20],      // Mint / Lavender
  lunar:       [9, 18],       // Daylight White / Indigo
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
