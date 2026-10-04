/**
 * The strobe functions, drawn by the show rather than asked of a fixture.
 *
 * They are the programs of a Cameo ROOT PAR 6's multifunction strobe channel —
 * a swell up and back down, a swell up cut to black, a hit that dies away,
 * each of them with random timing too, a random strobe, and a burst of
 * flashes with a break after it. The show used to get them by writing that
 * channel's DMX ranges to every fixture's strobe channel, which only a ROOT
 * PAR 6 understood: any other fixture read them as its own slow strobe, or
 * as nothing, and a fixture without a strobe channel ran a plain strobe
 * whatever was picked.
 *
 * Here every one of them is a level from 0 to 1 that multiplies a light's
 * brightness, worked out from the musical clock, so it looks the same on
 * every fixture in the rig and lands on the music: the speed picks how many
 * beats a swell or a burst takes rather than a rate in hertz. The random ones
 * roll their dice per light — every par, and every cell of a bar, on its own,
 * as a rig of fixtures each in its random mode would be — and the dice are a
 * hash of the light and the beat, so the same moment always draws the same
 * way, on the engine's thread and its worker alike.
 *
 * The standard strobe is not here: a fixture that has a strobe channel runs
 * that faster and crisper than any frame rate can (see server/renderer.ts).
 *
 * The flash timings are shared with the strobe programs in patterns.ts.
 */

// A flash: two frames at the engine's 44 a second, so none falls between two,
// and not much longer, or it reads as a blink.
const FLASH_MS = 45;
const FLASH_MAX_MS = 80;
// No light flashes more than about eleven times a second.
const MIN_SLOT_MS = 90;
// Without a tempo, a beat at 120 BPM.
const DEFAULT_BPM = 120;

const frac = (v: number): number => v - Math.floor(v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A stable pseudo-random 0..1 per cell and seed: the same scatter on every frame of a hit. */
function scatter(i: number, seed: number): number {
  let h = Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(seed + 7, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** How long a flash lasts in a slot `slotMs` long. */
function flashMsOf(slotMs: number): number {
  return Math.min(FLASH_MAX_MS, Math.max(FLASH_MS, 0.35 * slotMs));
}

/** Is a flash lit `phase` (0..1) into a slot `slotMs` long (a nanosecond's grace for rounding). */
function flashLit(phase: number, slotMs: number): boolean {
  return phase * slotMs < flashMsOf(slotMs) + 1e-6;
}

// ── Shapes ──────────────────────────────────────────────────────────────────
// Each is a level for how far through its swell a light is, 0..1. The ramps
// are squared, as an LED's output has to be for the eye to see it climb at an
// even rate rather than leap up and then crawl.

/** Up from black to full, cut to black at the end: the beat lands as the cut. */
const rampUp = (q: number): number => q * q;
/** Full at the start, dying away to black: the beat lands as the hit. */
const rampDown = (q: number): number => (1 - q) * (1 - q);
/** Up and back down, peaking in the middle. */
const swell = (q: number): number => {
  const s = Math.sin(Math.PI * q);
  return s * s;
};
/** Up and back down, peaking at the start and the end: on the beat. */
const swellOnTheBeat = (q: number): number => {
  const c = Math.cos(Math.PI * q);
  return c * c;
};

// ── Speeds ──────────────────────────────────────────────────────────────────
// The speed, 1–255, picks a rung of a ladder of lengths in beats, slow to
// fast. A rung too short to see at the tempo — a quarter-beat swell at 174
// BPM is a flicker — is doubled until it is not.

const RAMP_BEATS = [4, 2, 1, 1 / 2, 1 / 4];
const RAMP_MIN_MS = 120;
const RANDOM_BEATS = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16];
const BURST_BEATS = [8, 4, 2, 1];
const BURST_MIN_MS = 400;

/** How many beats one cycle lasts, for a speed and a ladder. */
function cycleBeats(raw: number, ladder: readonly number[], bpm: number, minMs: number): number {
  const rung = Math.min(ladder.length - 1, Math.floor((Math.max(0, Math.min(255, raw)) / 256) * ladder.length));
  const beatMs = 60000 / bpm;
  let beats = ladder[rung];
  while (beats * beatMs < minMs && beats < 64) beats *= 2;
  return beats;
}

// ── Random timing ───────────────────────────────────────────────────────────

// How many of a light's cycles get a swell, and how many of its slots a flash.
const RANDOM_RAMP_DENSITY = 0.7;
const RANDOM_FLASH_DENSITY = 0.55;

/** Does a light swell at all in this cycle of a random ramp? */
function swellsIn(cycle: number, light: number): boolean {
  return scatter(light, cycle * 3) < RANDOM_RAMP_DENSITY;
}

/**
 * A swell at a random moment of each cycle: most cycles get one, each at
 * least half the cycle long and starting anywhere it still fits, so no two
 * lights keep time together and no light runs like a clock.
 */
function randomSwell(shape: (q: number) => number, t: number, light: number): number {
  const cycle = Math.floor(t);
  if (!swellsIn(cycle, light)) return 0;
  const length = 0.5 + 0.5 * scatter(light, cycle * 3 + 1);
  const start = scatter(light, cycle * 3 + 2) * (1 - length);
  const q = (t - cycle - start) / length;
  return q >= 0 && q < 1 ? shape(q) : 0;
}

/** A flash at a random moment of a slot, in a little over half of them. */
function randomFlash(t: number, slotMs: number, light: number): number {
  const slot = Math.floor(t);
  if (scatter(light, slot) >= RANDOM_FLASH_DENSITY) return 0;
  const flash = flashMsOf(slotMs);
  const room = Math.max(0, 1 - flash / slotMs);
  const into = (t - slot - scatter(light, slot + 104729) * room) * slotMs;
  return into >= 0 && into < flash ? 1 : 0;
}

// ── Burst ───────────────────────────────────────────────────────────────────

/**
 * A burst of flashes from the top of every cycle, then a break to its end:
 * half a beat of them on the fastest, two beats every two bars on the
 * slowest, as many flashes as fit at the fastest a light may flash, evenly,
 * so the first lands on the beat.
 */
function burst(t: number, cycle: number, beatMs: number): number {
  const into = frac(t) * cycle;
  const length = Math.max(0.5, Math.min(2, cycle / 4));
  if (into >= length) return 0;
  const lengthMs = length * beatMs;
  const flashes = Math.max(2, Math.floor(lengthMs / MIN_SLOT_MS));
  const pos = (into / length) * flashes;
  return flashLit(frac(pos), lengthMs / flashes) ? 1 : 0;
}

// ── The functions ───────────────────────────────────────────────────────────

type Program = (t: number, cycle: number, beatMs: number, light: number) => number;

interface StrobeProgram {
  ladder: readonly number[];
  minMs: number;
  draw: Program;
}

const PROGRAMS: Record<string, StrobeProgram> = {
  'ramp-up-down':     { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => swellOnTheBeat(frac(t)) },
  'ramp-up-down-rnd': { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(swell, t, light) },
  'ramp-up':          { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => rampUp(frac(t)) },
  'ramp-up-rnd':      { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(rampUp, t, light) },
  'ramp-down':        { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t) => rampDown(frac(t)) },
  'ramp-down-rnd':    { ladder: RAMP_BEATS, minMs: RAMP_MIN_MS, draw: (t, _c, _b, light) => randomSwell(rampDown, t, light) },
  random: {
    ladder: RANDOM_BEATS, minMs: MIN_SLOT_MS,
    draw: (t, cycle, beatMs, light) => randomFlash(t, cycle * beatMs, light),
  },
  break: { ladder: BURST_BEATS, minMs: BURST_MIN_MS, draw: (t, cycle, beatMs) => burst(t, cycle, beatMs) },
};

/** Is this strobe function drawn by the show, rather than by a strobe channel? */
function drawnByTheShow(fnId: string): boolean {
  return Object.hasOwn(PROGRAMS, fnId);
}

/**
 * How lit a light is under a strobe function, 0..1, at a moment in the music.
 *
 * @param fnId     a function drawnByTheShow accepts; anything else is 1
 * @param raw      the speed, 1–255, slow to fast
 * @param beatPos  where the music is, in beats (shared/beat-clock.ts)
 * @param bpm      its tempo, or nothing to take 120
 * @param light    which light: the rig's unit index, the dice the random
 *                 functions roll for it
 */
function strobeLevel(fnId: string, raw: number, beatPos: number, bpm: number | null | undefined, light: number): number {
  const program = Object.hasOwn(PROGRAMS, fnId) ? PROGRAMS[fnId] : null;
  if (!program) return 1;
  const tempo = bpm && bpm > 0 ? bpm : DEFAULT_BPM;
  const cycle = cycleBeats(raw, program.ladder, tempo, program.minMs);
  return clamp01(program.draw(beatPos / cycle, cycle, 60000 / tempo, light));
}

export {
  FLASH_MS,
  FLASH_MAX_MS,
  MIN_SLOT_MS,
  scatter,
  flashLit,
  rampUp,
  rampDown,
  swell,
  swellsIn,
  randomSwell,
  randomFlash,
  burst,
  drawnByTheShow,
  strobeLevel,
};
