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

// Palette rebuilt around practical lighting design goals:
// - strong complementary contrast options
// - warm/cool families for mood shaping
// - neutral whites for subject visibility
// - UV/actinic accents for effect looks
// `Blackout` stays last (auto-show.js looks it up by name).
const COLOR_PRESETS = [
  { name: 'Crimson',        r: 255, g: 18,  b: 8,   w: 0,   a: 0,   uv: 0   }, // 0
  { name: 'Flame',          r: 255, g: 94,  b: 0,   w: 0,   a: 130, uv: 0   }, // 1
  { name: 'Amber',          r: 70,  g: 20,  b: 0,   w: 0,   a: 255, uv: 0   }, // 2
  { name: 'Sun',            r: 255, g: 220, b: 18,  w: 0,   a: 120, uv: 0   }, // 3
  { name: 'Lime',           r: 40,  g: 255, b: 40,  w: 0,   a: 0,   uv: 0   }, // 4
  { name: 'Aqua',           r: 0,   g: 225, b: 255, w: 0,   a: 0,   uv: 0   }, // 5
  { name: 'Cobalt',         r: 20,  g: 60,  b: 255, w: 0,   a: 0,   uv: 0   }, // 6
  { name: 'Violet',         r: 115, g: 20,  b: 255, w: 0,   a: 0,   uv: 0   }, // 7
  { name: 'Fuchsia',        r: 255, g: 0,   b: 165, w: 0,   a: 0,   uv: 0   }, // 8
  { name: 'Daylight White', r: 0,   g: 0,   b: 0,   w: 255, a: 0,   uv: 0   }, // 9
  { name: 'UV',         r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 }, // 10
  { name: 'Actinic',        r: 85,  g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 11
  { name: 'Rose',           r: 255, g: 84,  b: 182, w: 0,   a: 0,   uv: 0   }, // 12
  { name: 'Teal',           r: 0,   g: 188, b: 160, w: 0,   a: 0,   uv: 0   }, // 13
  { name: 'Gold',           r: 255, g: 155, b: 20,  w: 0,   a: 225, uv: 0   }, // 14
  { name: 'Tungsten White', r: 95,  g: 35,  b: 0,   w: 255, a: 175, uv: 0   }, // 15
  { name: 'Mint',           r: 0,   g: 255, b: 145, w: 0,   a: 0,   uv: 0   }, // 16
  { name: 'Sky',            r: 80,  g: 185, b: 255, w: 0,   a: 0,   uv: 0   }, // 17
  { name: 'Indigo',         r: 35,  g: 0,   b: 190, w: 0,   a: 0,   uv: 0   }, // 18
  { name: 'Coral',          r: 255, g: 112, b: 78,  w: 0,   a: 55,  uv: 0   }, // 19
  { name: 'Lavender',       r: 165, g: 120, b: 255, w: 0,   a: 0,   uv: 0   }, // 20
  { name: 'Acid',           r: 186, g: 255, b: 0,   w: 0,   a: 0,   uv: 0   }, // 21
  { name: 'Moonlight',      r: 30,  g: 45,  b: 85,  w: 180, a: 0,   uv: 0   }, // 22
  { name: 'Blackout',       r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 23
];

const PATTERNS = [
  { id: 'solid',        name: 'Solid',         desc: 'All fixtures same colour' },
  { id: 'chase',        name: 'Chase →',       desc: 'One fixture at a time, forward' },
  { id: 'chase-rev',    name: 'Chase ←',       desc: 'One fixture at a time, reverse' },
  { id: 'ping-pong',    name: 'Ping Pong',     desc: 'Forward then backward' },
  { id: 'strobe',       name: 'Strobe',        desc: 'All fixtures strobe on beat' },
  { id: 'fade',         name: 'Fade',          desc: 'Fade in/out together' },
  { id: 'color-cycle',  name: 'Colour Cycle',  desc: 'Cycle through hues in sync' },
  { id: 'rainbow',      name: 'Rainbow',       desc: 'Each fixture offset in hue' },
  { id: 'twinkle',      name: 'Twinkle',       desc: 'Random fixtures flash' },
  { id: 'split',        name: 'Split',         desc: 'Two colours alternating in pairs' },
  { id: 'sparkle',      name: 'Sparkle',       desc: 'Bright random pulses, instant' },
  { id: 'wave',         name: 'Wave',          desc: 'Sine brightness wave across fixtures' },
  { id: 'stack-up',     name: 'Stack Up',      desc: 'Fill fixtures one-by-one then reset' },
  { id: 'random-flash', name: 'Random Flash',  desc: 'Random fixture pops each beat' },
  { id: 'runner',       name: 'Runner',        desc: 'Chase with a fading trail' },
  { id: 'pairs',        name: 'Pairs',         desc: 'Two adjacent fixtures chase' },
  { id: 'hit',          name: 'Hit',           desc: 'All fixtures punch on beat, decay between' },
  { id: 'alt-halves',   name: 'Alt Halves',    desc: 'Two halves swap colours each beat' },
  { id: 'split-3',      name: 'Split 3',       desc: 'Three colours cycling across fixtures' },
  { id: 'chase-3',      name: 'Chase 3',       desc: 'Chase rotating through three colours' },
  { id: 'alt-thirds',   name: 'Alt Thirds',    desc: 'Three sections swap colours each beat' },
  { id: 'split-4',      name: 'Split 4',       desc: 'Four colours cycling across fixtures' },
  { id: 'chase-4',      name: 'Chase 4',       desc: 'Chase rotating through four colours' },
  { id: 'alt-quarters', name: 'Alt Quarters',  desc: 'Four sections swap colours each beat' },
  { id: 'pairs-4',      name: 'Pairs 4',       desc: 'Adjacent pairs chase with four colours' },
];

const PATTERN_IDS = PATTERNS.map((p) => p.id);

const ENERGY_EFFECTS = [
  { id: 'white-strobe',  name: 'White Strobe',  desc: 'Full white + fast strobe' },
  { id: 'blinder',       name: 'Blinder',       desc: 'Full white wall of light' },
  { id: 'uv-strobe',     name: 'UV Strobe',     desc: 'Full UV + fast strobe' },
  { id: 'color-strobe',  name: 'Colour Strobe', desc: 'Colour A + fast strobe' },
  { id: 'all-on',        name: 'All On',        desc: 'Every channel maxed out' },
];

const ENERGY_EFFECT_IDS = ENERGY_EFFECTS.map((e) => e.id);

const AUTO_SOURCES = ['auto', 'spotify', 'prolink', 'timer'];

module.exports = {
  STROBE_FUNCTIONS,
  STROBE_FUNCTION_IDS,
  COLOR_PRESETS,
  PATTERNS,
  PATTERN_IDS,
  ENERGY_EFFECTS,
  ENERGY_EFFECT_IDS,
  AUTO_SOURCES,
};
