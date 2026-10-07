import { CATALOGUE, presetById } from '../shared/effects/index.ts';
import { ENERGY_KIND_BY_ID } from '../shared/effects/energy.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';

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

// Separate saturated presets by at least 30° so their differences remain visible across a room.
const COLOR_PRESETS = [
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 0    0°
  { name: 'Amber',      r: 200, g: 150, b: 0,   w: 0,   a: 255, uv: 0   }, // 1   37° amber emitter leads
  { name: 'Lime',       r: 150, g: 255, b: 0,   w: 0,   a: 0,   uv: 0   }, // 2   85°
  { name: 'Green',      r: 0,   g: 255, b: 85,  w: 0,   a: 0,   uv: 0   }, // 3  140° emerald, not the
  { name: 'Cyan',       r: 0,   g: 225, b: 255, w: 0,   a: 0,   uv: 0   }, // 4  187°
  { name: 'Blue',       r: 0,   g: 85,  b: 255, w: 0,   a: 0,   uv: 0   }, // 5  220°
  { name: 'Congo Blue', r: 75,  g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 6  258° the deep one
  { name: 'Violet',     r: 205, g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 7  288°
  { name: 'Magenta',    r: 255, g: 0,   b: 150, w: 0,   a: 0,   uv: 0   }, // 8  325° reads as hot pink

  { name: 'Warm White', r: 90,  g: 30,  b: 0,   w: 255, a: 200, uv: 0   }, // 9  tungsten
  { name: 'Cool White', r: 0,   g: 30,  b: 80,  w: 255, a: 0,   uv: 0   }, // 10 daylight

  { name: 'Lavender',   r: 130, g: 45,  b: 200, w: 200, a: 0,   uv: 0   }, // 11
  { name: 'Moonlight',  r: 0,   g: 70,  b: 190, w: 190, a: 0,   uv: 0   }, // 12

  { name: 'UV',         r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 }, // 13
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 14
];

// Legacy patterns have no EffectSpec and cannot run as pads, clips or voices.
const PATTERNS = [
  { id: 'solid',        name: 'Solid',         desc: 'All fixtures on colour A' },
  { id: 'fade',         name: 'Fade',          desc: 'All fixtures breathe together' },
  { id: 'hit',          name: 'Hit',           desc: 'All fixtures punch on the beat, decay between' },
  { id: 'strobe',       name: 'Strobe',        desc: 'All fixtures strobe on the beat' },
  { id: 'color-cycle',  name: 'Colour Cycle',  desc: 'Whole rig steps to the next palette colour' },
  { id: 'rainbow',      name: 'Rainbow',       desc: 'Full spectrum spread across the rig — ignores the palette' },

  { id: 'chase',        name: 'Chase →',       desc: 'One fixture at a time, forward' },
  { id: 'chase-rev',    name: 'Chase ←',       desc: 'One fixture at a time, reverse' },
  { id: 'ping-pong',    name: 'Ping Pong',     desc: 'One fixture at a time, forward then back' },
  { id: 'runner',       name: 'Runner',        desc: 'Chase with a fading trail' },
  { id: 'pairs',        name: 'Pairs',         desc: 'Two adjacent fixtures travel together' },
  { id: 'wave',         name: 'Wave',          desc: 'Sine brightness sweep across the rig' },
  { id: 'stack-up',     name: 'Stack Up',      desc: 'Fill fixtures one by one, then reset' },

  { id: 'split',        name: 'Split',         desc: 'Palette colours alternating per fixture' },
  { id: 'sections',     name: 'Sections',      desc: 'Rig splits into one block per palette colour, blocks swap each beat' },

  { id: 'twinkle',      name: 'Twinkle',       desc: 'Soft random levels, nothing goes fully dark' },
  { id: 'sparkle',      name: 'Sparkle',       desc: 'Hard random on/off, instant' },
  { id: 'random-flash', name: 'Random Flash',  desc: 'One random fixture pops each beat' },
  { id: 'ensemble', name: 'Ensemble', desc: 'Bass at the edges, vocals in the centre, airy moving accents' },
  { id: 'ribbon', name: 'Ribbon', desc: 'Continuous palette ribbons shaped by musical texture and width' },

  { id: 'gradient', name: 'Gradient', desc: 'The look\'s colours as a gradient scrolling across the rig', pixel: true },
  { id: 'comet',    name: 'Comet',    desc: 'A head crossing the rig every four steps with a fading tail', pixel: true },
  { id: 'burst',    name: 'Burst',    desc: 'A ring thrown out from the centre of the stage on every step', pixel: true },
  { id: 'plasma',   name: 'Plasma',   desc: 'Slow interfering waves in the look\'s colours', pixel: true },
  { id: 'meter',    name: 'Meter',    desc: 'A level meter filled by the low end, kicked on every step', pixel: true },
  { id: 'drums',    name: 'Drums',    desc: 'The kit as it is hit: kick from the middle, snare at the ends, hats scattered', pixel: true },
  { id: 'stems',    name: 'Stems',    desc: 'Voice, band, drums and bass in zones out from the centre, each as loud as it plays', pixel: true },
  { id: 'rise',     name: 'Rise',     desc: 'The rig filling up through a build-up, full on the drop', pixel: true },
  { id: 'impact',   name: 'Impact',   desc: 'A ring thrown out from the centre on every step, with sparks on every kick', pixel: true },
  { id: 'bars',     name: 'Bars',     desc: 'A spectrum analyser: kick, bass, drums, snare, band, voice and hats as columns, as high as each plays', pixel: true },
  { id: 'fire',     name: 'Fire',     desc: 'Flames licking up a panel, taller with the bass, flaring on the kick', pixel: true },
  { id: 'rain',     name: 'Rain',     desc: 'Drops falling down every column in time, the hats shaking loose more', pixel: true },
  { id: 'flash-chase',     name: 'Flash Chase',     desc: 'One flash stepping zone to zone, a lap a step', pixel: true },
  { id: 'flash-scatter',   name: 'Flash Scatter',   desc: 'Random zones strobing, denser with the hats', pixel: true },
  { id: 'flash-fill',      name: 'Flash Fill',      desc: 'Every step fills from the middle out, holds, and cuts to black', pixel: true },
  { id: 'flash-alternate', name: 'Flash Alternate', desc: 'Odd zones flash on the step, even ones between', pixel: true },
  { id: 'ramp',            name: 'Ramp',            desc: 'Every step swells from black to full from the middle, cut on the beat', pixel: true },
  { id: 'core',            name: 'Strobe Core',     desc: 'A colour wash with a white core striking on every kick', pixel: true },
  ...CATALOGUE.filter((p) => p.legacy).map(({ id, name, desc, party, preset }) => ({ id, name, desc, party, ...(preset ? { preset } : {}) })),
].map((row) => ({ ...row, legacy: true as const }));

const PATTERN_IDS = PATTERNS.map((p) => p.id);

// Use the effective rapid-flash requirement so pickers match renderer admission.
const PRESET_ROWS = CATALOGUE.flatMap((p) => p.legacy ? [] : [{
  id: p.id, name: p.name, desc: p.desc, ...(p.party ? { party: true } : {}), ...(p.pixel ? { pixel: true } : {}),
  app: p.app, family: p.family, rapidFlash: requiresAcknowledgement(p.spec), scope: p.spec.scope ?? null,
}]);

const ENERGY_EFFECTS = [...Object.keys(ENERGY_KIND_BY_ID), 'palette-strobe'].map((id) => {
  const { name, desc } = presetById(id)!;
  return { id, name, desc };
});

const ENERGY_EFFECT_IDS = ENERGY_EFFECTS.map((e) => e.id);

// Keep sync bounds shared so settings, MIDI and playback accept the same range.
const SYNC_OFFSET_LIMIT_MS = 2000;

const AUTO_SOURCES = ['auto', 'hybrid', 'spotify', 'deezer', 'nowplaying', 'prolink', 'live', 'timer'] as const;

const TEMPO_MODES = ['auto', 'manual'] as const;

export {
  STROBE_FUNCTIONS,
  STROBE_FUNCTION_IDS,
  COLOR_PRESETS,
  PATTERNS,
  PATTERN_IDS,
  PRESET_ROWS,
  ENERGY_EFFECTS,
  ENERGY_EFFECT_IDS,
  AUTO_SOURCES,
  TEMPO_MODES,
  SYNC_OFFSET_LIMIT_MS,
};
