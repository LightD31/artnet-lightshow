'use strict';

// Each entry defines a DMX range on channel 3. Speed-based functions map
// the 0-255 strobeSpeed value into the [lo..hi] range (slow → fast).
const STROBE_FUNCTIONS = [
  { id: 'standard',         name: 'Standard',         desc: 'Strobe slow → fast (1-20 Hz)', lo: 128, hi: 250 },
  { id: 'ramp-up-down',     name: 'Ramp Up/Down',     desc: 'Ramp up/down, slow → fast',    lo: 11,  hi: 22  },
  { id: 'ramp-up-down-rnd', name: 'Ramp Up/Down Rnd', desc: 'Ramp up/down random',          lo: 23,  hi: 33  },
  { id: 'ramp-up',          name: 'Ramp Up',          desc: 'Ramp up, slow → fast',         lo: 34,  hi: 45  },
  { id: 'ramp-up-rnd',      name: 'Ramp Up Rnd',      desc: 'Ramp up random, slow → fast',  lo: 46,  hi: 56  },
  { id: 'ramp-down',        name: 'Ramp Down',        desc: 'Ramp down, slow → fast',       lo: 57,  hi: 68  },
  { id: 'ramp-down-rnd',    name: 'Ramp Down Rnd',    desc: 'Ramp down random, slow → fast',lo: 69,  hi: 79  },
  { id: 'random',           name: 'Random',           desc: 'Random strobe, slow → fast',   lo: 80,  hi: 102 },
  { id: 'break',            name: 'Break',            desc: 'Burst with break, 5s → 1s',    lo: 103, hi: 127 },
];

const STROBE_FUNCTION_IDS = STROBE_FUNCTIONS.map((f) => f.id);

// ── Colour presets ──────────────────────────────────────────────────────────
//
// A party rig is watched from across a dark room, through haze, on lamps that
// are usually moving or flashing. Two colours that a screen shows as clearly
// different — say a 260° violet and a 264° "actinic" — arrive at the audience
// as the same colour, so a table full of near-neighbours is a table where most
// of the buttons do the same thing. The list below is built the other way
// round: pick the fewest colours that are all *obviously* different from each
// other, and let the palettes and the four slots do the combining.
//
// The rule is one preset per recognisable hue, with no two saturated entries
// closer than 30° on the wheel:
//
//   Red 0° · Amber 37° · Lime 85° · Green 140° · Cyan 187°
//   Blue 220° · Congo 258° · Violet 288° · Magenta 325°
//
// Nine hues is the whole wheel at the resolution the eye resolves at distance.
// Everything that used to sit between two of these (Coral, Flame, Gold, Sun,
// Yellow, Rose, Fuchsia, Teal, Mint, Sky, Indigo, Actinic, Acid) collapsed into
// its nearest neighbour; nothing was lost that a pair of slots cannot rebuild.
//
// Yellow is the one that may look missing. It went because the amber emitter
// puts Amber at 37° and an RGB yellow at 60° — 23° apart, which is a difference
// on a screen and not one across a dark room. Amber is also the more useful
// half of that pair on a party rig: an RGB yellow tends to arrive as dirty
// white once there is any haze in the air.
//
// Then three things a hue cannot do:
//   - Warm/Cool White — the blinder and the "lights up" look. Two of them,
//     because warm-vs-cool is the one white distinction that reads on stage.
//   - Lavender / Moonlight — the pale tier. Deliberately desaturated: a wash
//     you can leave up under everything else, for the chill-out end of the
//     night, where a saturated colour would just be loud.
//   - UV — blacklight, which no RGB mix approximates.
//
// `Blackout` stays last (auto-show.js looks it up by name).
const COLOR_PRESETS = [
  // Saturated wheel — the workhorses. One entry per recognisable hue. The
  // angles are the *mixed* hue: Amber is mostly the amber emitter, so its r/g/b
  // triple on its own reads much redder than what the lamp puts out.
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 0    0°
  { name: 'Amber',      r: 200, g: 150, b: 0,   w: 0,   a: 255, uv: 0   }, // 1   37° amber emitter leads
  { name: 'Lime',       r: 150, g: 255, b: 0,   w: 0,   a: 0,   uv: 0   }, // 2   85°
  { name: 'Green',      r: 0,   g: 255, b: 85,  w: 0,   a: 0,   uv: 0   }, // 3  140° emerald, not the
                                                                           //         yellowish raw primary
  { name: 'Cyan',       r: 0,   g: 225, b: 255, w: 0,   a: 0,   uv: 0   }, // 4  187°
  { name: 'Blue',       r: 0,   g: 85,  b: 255, w: 0,   a: 0,   uv: 0   }, // 5  220°
  { name: 'Congo Blue', r: 75,  g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 6  258° the deep one
  { name: 'Violet',     r: 205, g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 7  288°
  { name: 'Magenta',    r: 255, g: 0,   b: 150, w: 0,   a: 0,   uv: 0   }, // 8  325° reads as hot pink

  // Whites — warm and cool, the one white distinction that carries across a room.
  { name: 'Warm White', r: 90,  g: 30,  b: 0,   w: 255, a: 200, uv: 0   }, // 9  tungsten
  { name: 'Cool White', r: 0,   g: 30,  b: 80,  w: 255, a: 0,   uv: 0   }, // 10 daylight

  // Pale tier — low saturation on purpose. These are washes to sit *under* a
  // look, not colours to chase with.
  { name: 'Lavender',   r: 130, g: 45,  b: 200, w: 200, a: 0,   uv: 0   }, // 11
  { name: 'Moonlight',  r: 0,   g: 70,  b: 190, w: 190, a: 0,   uv: 0   }, // 12

  { name: 'UV',         r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 }, // 13
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 14
];

// ── Patterns ────────────────────────────────────────────────────────────────
//
// Grouped by what the rig actually *does*, because that is what an audience
// tells apart. Twenty-five entries had collapsed into a handful of silhouettes
// wearing different names: split / split-3 / split-4 were one pattern picked
// three ways, as were chase / chase-3 / chase-4, alt-halves / alt-thirds /
// alt-quarters, and pairs / pairs-4. The only thing the suffix changed was how
// many colours the pattern reached for.
//
// Patterns now read that from the look itself (patterns.js paletteOf), so one
// `split` covers all three sizes and the picker is eighteen genuinely different
// motions rather than twenty-five names for eleven.
const PATTERNS = [
  // Whole rig, together.
  { id: 'solid',        name: 'Solid',         desc: 'All fixtures on colour A' },
  { id: 'fade',         name: 'Fade',          desc: 'All fixtures breathe together' },
  { id: 'hit',          name: 'Hit',           desc: 'All fixtures punch on the beat, decay between' },
  { id: 'strobe',       name: 'Strobe',        desc: 'All fixtures strobe on the beat' },
  { id: 'color-cycle',  name: 'Colour Cycle',  desc: 'Whole rig steps to the next palette colour' },
  { id: 'rainbow',      name: 'Rainbow',       desc: 'Full spectrum spread across the rig — ignores the palette' },

  // One or two lamps travelling, the rest held low.
  { id: 'chase',        name: 'Chase →',       desc: 'One fixture at a time, forward' },
  { id: 'chase-rev',    name: 'Chase ←',       desc: 'One fixture at a time, reverse' },
  { id: 'ping-pong',    name: 'Ping Pong',     desc: 'One fixture at a time, forward then back' },
  { id: 'runner',       name: 'Runner',        desc: 'Chase with a fading trail' },
  { id: 'pairs',        name: 'Pairs',         desc: 'Two adjacent fixtures travel together' },
  { id: 'wave',         name: 'Wave',          desc: 'Sine brightness sweep across the rig' },
  { id: 'stack-up',     name: 'Stack Up',      desc: 'Fill fixtures one by one, then reset' },

  // Static blocks that rotate on the beat.
  { id: 'split',        name: 'Split',         desc: 'Palette colours alternating per fixture' },
  { id: 'sections',     name: 'Sections',      desc: 'Rig splits into one block per palette colour, blocks swap each beat' },

  // Random.
  { id: 'twinkle',      name: 'Twinkle',       desc: 'Soft random levels, nothing goes fully dark' },
  { id: 'sparkle',      name: 'Sparkle',       desc: 'Hard random on/off, instant' },
  { id: 'random-flash', name: 'Random Flash',  desc: 'One random fixture pops each beat' },
];

const PATTERN_IDS = PATTERNS.map((p) => p.id);

// ── Energy overrides ────────────────────────────────────────────────────────
//
// One-touch panic effects. They trump the pattern engine and per-fixture
// overrides (see engine.js resolveEnergyOverride) — only master blackout wins.
//
// Same problem as the colour table: `blinder` and `all-on` were both "a white
// wall at full", differing only in whether amber and UV joined in, which from
// the floor is not a difference. They are now one effect that drives every
// white-making emitter, which is both simpler and brighter than either was.
//
// What is left covers four separate things an operator reaches for, so no two
// buttons do the same job:
//   - a strobe punch, cold (white-strobe) or in the look's own colour
//     (color-strobe)
//   - a held wall of light (blinder)
//   - a held *dark* moment — blacklight (uv-wash) or nothing at all (kill)
//
// `kill` is not master blackout: the master is a latching switch on the whole
// rig, this is momentary and auto-clears, which is what you want under a thumb
// on a drop.
const ENERGY_EFFECTS = [
  { id: 'white-strobe', name: 'White Strobe',  desc: 'Cold white, fastest strobe' },
  { id: 'color-strobe', name: 'Colour Strobe', desc: 'Colour A, fastest strobe' },
  { id: 'blinder',      name: 'Blinder',       desc: 'Every emitter at full — the brightest the rig goes' },
  { id: 'uv-wash',      name: 'UV Wash',       desc: 'Blacklight — UV alone, no strobe' },
  { id: 'kill',         name: 'Kill',          desc: 'Everything out for as long as it is held' },
];

const ENERGY_EFFECT_IDS = ENERGY_EFFECTS.map((e) => e.id);

// How far the operator can shift the generated show against the music, either
// way. Two seconds covers every real source of lag — player buffering, a polled
// and quantised position API, Art-Net across a network, fixture processing, and
// the throw from a PA to the back of a room — with room to spare. Wider than
// this and a mis-drag stops being a sync adjustment and starts being a
// different part of the song.
//
// Lives here, with the other domain tables, because the settings store, the
// patch validator, the MIDI surface and the auto show all need it, and this is
// the only module among them that requires nothing itself.
const SYNC_OFFSET_LIMIT_MS = 2000;

// 'hybrid' takes its content from Spotify (track identity, ISRC, duration and
// the queue lookahead) and its clock from the OS media session, which is read
// locally and so is both fresher and far steadier than a polled HTTP API.
// See src/hybrid-source.js.
const AUTO_SOURCES = ['auto', 'hybrid', 'spotify', 'deezer', 'nowplaying', 'prolink', 'timer'];

module.exports = {
  STROBE_FUNCTIONS,
  STROBE_FUNCTION_IDS,
  COLOR_PRESETS,
  PATTERNS,
  PATTERN_IDS,
  ENERGY_EFFECTS,
  ENERGY_EFFECT_IDS,
  AUTO_SOURCES,
  SYNC_OFFSET_LIMIT_MS,
};
