import { COLOR_PRESETS } from './presets.ts';

// Preset indices: 0 Red, 1 Amber, 2 Lime, 3 Green, 4 Cyan, 5 Blue, 6 Congo Blue, 7 Violet,
// 8 Magenta, 9 Warm White, 10 Cool White, 11 Lavender, 12 Moonlight, 13 UV, 14 Blackout.
// Tetrad slots: A dominant, B contrast, C accent, D lift.
// Separate saturated hues by about 30° so each slot remains visible across the room.

export type PaletteBank = Record<string, number[]>;

const TETRADS: PaletteBank = {
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

  whiteout:    [10, 6, 8, 12], // Cool White / Congo / Magenta / Moonlight — white room, neon cuts
  strobeLab:   [10, 4, 0, 9],  // Cool White / Cyan / Red / Warm White — clinical white, hot and cold
  hardTechno:  [10, 0, 5, 12], // Cool White / Red / Blue / Moonlight — warehouse: white, siren, blue
  ultraviolet: [13, 10, 8, 12],// UV / Cool White / Magenta / Moonlight — blacklight under a white slash
  acidRave:    [2, 8, 6, 10],  // Lime / Magenta / Congo / Cool White — acid green against hot pink
  iceFire:     [4, 0, 8, 10],  // Cyan / Red / Magenta / Cool White — the cold/hot split, hard edge

  midnight:    [5, 8, 2, 12],  // Blue / Magenta / Lime / Moonlight — deep blue with two sharp cuts
  peppermint:  [0, 3, 4, 10],  // Red / Green / Cyan / Cool White — primary and bright, nothing muddy
  mint:        [3, 0, 7, 10],  // Green / Red / Violet / Cool White — fresh green over a red contrast
  nightDrive:  [6, 1, 4, 12],  // Congo / Amber / Cyan / Moonlight — headlights on a deep blue road
};

// Triads usually omit the lift so a third lamp still contributes a distinct hue.
const TRIADS: PaletteBank = {
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
  whiteout:    [10, 6, 8],    // Cool White / Congo / Magenta
  strobeLab:   [10, 4, 0],    // Cool White / Cyan / Red
  hardTechno:  [10, 0, 5],    // Cool White / Red / Blue
  ultraviolet: [13, 10, 8],   // UV / Cool White / Magenta
  acidRave:    [2, 8, 6],     // Lime / Magenta / Congo
  iceFire:     [4, 0, 8],     // Cyan / Red / Magenta
  midnight:    [5, 8, 2],     // Blue / Magenta / Lime
  peppermint:  [0, 3, 4],     // Red / Green / Cyan
  mint:        [3, 0, 7],     // Green / Red / Violet
  nightDrive:  [6, 1, 4],     // Congo / Amber / Cyan
};

// Duos need strong hue or brightness contrast because each colour occupies half the rig.
const DUOS: PaletteBank = {
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
  whiteout:    [10, 8],       // Cool White / Magenta — tier contrast
  strobeLab:   [10, 0],       // Cool White / Red — tier contrast
  hardTechno:  [10, 5],       // Cool White / Blue — tier contrast
  ultraviolet: [13, 8],       // UV / Magenta
  acidRave:    [2, 6],        // Lime / Congo
  iceFire:     [4, 0],        // Cyan / Red
  midnight:    [5, 8],        // Blue / Magenta
  peppermint:  [0, 3],        // Red / Green
  mint:        [3, 10],       // Green / Cool White — tier contrast
  nightDrive:  [6, 12],       // Congo / Moonlight — tier contrast
};

function paletteBankForSize(size: number): PaletteBank {
  if (size === 2) return DUOS;
  if (size === 3) return TRIADS;
  return TETRADS;
}

const PALETTE_NAMES: Record<string, string> = {
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
  whiteout:    'Whiteout',
  strobeLab:   'Strobe Lab',
  hardTechno:  'Hard Techno',
  ultraviolet: 'Ultraviolet',
  acidRave:    'Acid Rave',
  iceFire:     'Ice & Fire',
  midnight:    'Midnight',
  peppermint:  'Peppermint',
  mint:        'Mint',
  nightDrive:  'Night Drive',
};

const PALETTES = Object.keys(TETRADS).map((id) => ({
  id,
  name: PALETTE_NAMES[id] || id,
  colors: { 2: DUOS[id], 3: TRIADS[id], 4: TETRADS[id] },
}));

const PALETTE_IDS = PALETTES.map((p) => p.id);

function paletteColors(id: string, size = 4): number[] | null {
  const bank = paletteBankForSize(size);
  const raw = bank[id];
  if (!Array.isArray(raw) || !raw.length) return null;
  const maxIdx = COLOR_PRESETS.length - 1;
  return raw.map((i) => Math.max(0, Math.min(maxIdx, i)));
}

function paletteSlots(id: string, size = 4): { colorA: number; colorB: number; colorC: number; colorD: number } | null {
  const colors = paletteColors(id, size);
  if (!colors) return null;
  return {
    colorA: colors[0 % colors.length],
    colorB: colors[1 % colors.length],
    colorC: colors[2 % colors.length],
    colorD: colors[3 % colors.length],
  };
}

export {
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
