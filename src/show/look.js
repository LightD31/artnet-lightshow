'use strict';

/**
 * The look vocabulary: which colours a track gets, and which patterns suit a
 * section of it.
 *
 * Split out of the show engine so that "what does this music look like" is one
 * decision with one home, testable without building a timeline. The director
 * asks this module for a palette and for patterns; it never reaches into the
 * palette banks itself.
 *
 * Nothing here reads the audio. It reads the *interpretation* — key, mood,
 * style, section character — which is the analyser's job, and turns it into
 * rig-facing choices.
 */

const { paletteBankForSize } = require('../server/palettes');

// Each style picks from a short preference list; which entry it lands on is
// keyed on the musical key, so two EDM tracks in different keys get different
// looks from the same vocabulary.
//
// `tier` is the throttle on everything the rig does:
//   dance     full banger — colour-strobe accents, drop slams, white strobe on
//             proper drops only
//   moderate  reduced bursts, no white strobe
//   rock      light bursts, proper drops only
//   calm      no strobes, no drops
const GENRE_STYLES = {
  edm:       { tier: 'dance',    tetrads: ['synthwave', 'aurora', 'arctic'],
               patterns: ['pairs', 'runner', 'chase', 'split', 'stack-up', 'random-flash', 'hit', 'sections'] },
  dubstep:   { tier: 'dance',    tetrads: ['volcanic', 'noirUv', 'synthwave'],
               patterns: ['random-flash', 'stack-up', 'split', 'pairs', 'runner', 'hit', 'sections'] },
  trance:    { tier: 'dance',    tetrads: ['arctic', 'violetDream', 'aurora', 'synthwave'],
               patterns: ['sparkle', 'wave', 'twinkle', 'runner', 'hit', 'chase', 'sections'] },
  disco:     { tier: 'dance',    tetrads: ['candyPop', 'sunsetDrive', 'solarPunch'],
               patterns: ['ping-pong', 'chase', 'sparkle', 'pairs', 'sections', 'split'] },
  hiphop:    { tier: 'moderate', tetrads: ['volcanic', 'desert', 'royal'],
               patterns: ['pairs', 'split', 'chase', 'stack-up', 'runner', 'sections'] },
  pop:       { tier: 'moderate', tetrads: ['candyPop', 'sunsetDrive', 'tropical'],
               patterns: ['ping-pong', 'wave', 'chase', 'sparkle', 'pairs', 'split'] },
  funk:      { tier: 'moderate', tetrads: ['solarPunch', 'tropical', 'sunsetDrive'],
               patterns: ['ping-pong', 'pairs', 'runner', 'chase', 'wave', 'sections', 'split'] },
  rock:      { tier: 'rock',     tetrads: ['volcanic', 'solarPunch', 'desert'],
               patterns: ['chase', 'runner', 'pairs', 'ping-pong', 'stack-up'] },
  metal:     { tier: 'rock',     tetrads: ['volcanic', 'noirUv', 'royal'],
               patterns: ['stack-up', 'split', 'random-flash', 'runner', 'pairs', 'hit'] },
  country:   { tier: 'rock',     tetrads: ['desert', 'solarPunch', 'sunsetDrive'],
               patterns: ['wave', 'chase', 'runner', 'ping-pong', 'fade'] },
  reggae:    { tier: 'rock',     tetrads: ['emeraldCity', 'tropical', 'solarPunch'],
               patterns: ['wave', 'fade', 'chase', 'ping-pong', 'pairs'] },
  latin:     { tier: 'calm',     tetrads: ['sunsetDrive', 'tropical', 'solarPunch'],
               patterns: ['ping-pong', 'runner', 'chase', 'pairs', 'wave'] },
  jazz:      { tier: 'calm',     tetrads: ['royal', 'lunar', 'violetDream'],
               patterns: ['solid', 'fade', 'wave', 'twinkle', 'sparkle'] },
  classical: { tier: 'calm',     tetrads: ['lunar', 'arctic', 'royal'],
               patterns: ['solid', 'fade', 'wave', 'twinkle'] },
  folk:      { tier: 'calm',     tetrads: ['desert', 'emeraldCity', 'lunar'],
               patterns: ['solid', 'fade', 'wave', 'twinkle'] },
  ambient:   { tier: 'calm',     tetrads: ['deepOcean', 'aurora', 'arctic'],
               patterns: ['solid', 'fade', 'wave', 'twinkle', 'sparkle'] },
};

// Fallback palette preferences when the classifier has no answer, mapped onto
// Russell's circumplex of affect (arousal × valence):
//
//                    high arousal
//                         │
//       angry / tense    ─┼─   excited / happy
//  low valence ───────────┼─────────── high valence
//       sad / reflective  │    content / calm
//                    low arousal
//
// The key still selects which entry inside a quadrant, so two same-mood tracks
// in different keys diverge.
const CIRCUMPLEX_TETRADS = {
  highPos: ['sunsetDrive', 'candyPop', 'tropical', 'solarPunch'],
  highNeg: ['volcanic', 'noirUv', 'halloween', 'synthwave'],
  lowPos:  ['desert', 'emeraldCity', 'lunar', 'royal'],
  lowNeg:  ['deepOcean', 'arctic', 'aurora', 'lunar'],
};

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Patterns that lock to the pulse, and patterns that float over it. The
// director picks between the two sets by danceability rather than by energy:
// a loud track with no steady pulse wants motion, not a chase.
const RHYTHMIC = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong',
  'split', 'sections', 'stack-up', 'random-flash', 'hit', 'color-cycle']);
const FLOWY = new Set(['solid', 'fade', 'wave', 'sparkle', 'twinkle']);

/** The style entry for a genre label, or null when there is no answer. */
function styleFor(genre) {
  if (!genre) return null;
  const label = typeof genre === 'string' ? genre : genre.label;
  return GENRE_STYLES[label] || null;
}

/**
 * Show tier for a track: the single most consequential decision in the engine,
 * because it is what decides whether the rig strobes at all.
 *
 * Prefers the analyser's own `style` (which came from the tagger, or from its
 * own tempo/arousal fallback), then the genre table, then arousal.
 */
function tierFor(analysis, mood) {
  const style = styleFor(analysis && analysis.genre);
  if (style) return style.tier;
  const declared = analysis && analysis.genre && analysis.genre.style;
  if (declared && ['dance', 'moderate', 'rock', 'calm'].includes(declared)) return declared;
  const arousal = mood && mood.arousal != null ? mood.arousal : 0;
  return arousal >= 0.72 ? 'dance' : arousal >= 0.62 ? 'moderate'
    : arousal >= 0.42 ? 'rock' : 'unknown';
}

/**
 * One coherent palette for the whole track.
 *
 * Locked for the song's full duration on purpose: a show that re-picks colours
 * per section has no identity, and coming back to the chorus has to *look*
 * like coming back to the chorus.
 */
function buildPalette({ key, scale, mood = {}, genreStyle = null, paletteSize = 4,
  colorPresets = null }) {
  const keyIndex = Math.max(0, KEYS.indexOf(key));

  let names;
  if (genreStyle && genreStyle.tetrads && genreStyle.tetrads.length) {
    names = genreStyle.tetrads;
  } else {
    const valence = mood.valence != null ? mood.valence : (scale === 'major' ? 0.65 : 0.35);
    const arousal = mood.arousal != null ? mood.arousal : 0.5;
    if (arousal >= 0.5 && valence >= 0.5) names = CIRCUMPLEX_TETRADS.highPos;
    else if (arousal >= 0.5) names = CIRCUMPLEX_TETRADS.highNeg;
    else if (valence >= 0.5) names = CIRCUMPLEX_TETRADS.lowPos;
    else names = CIRCUMPLEX_TETRADS.lowNeg;
  }

  const bank = paletteBankForSize(paletteSize);
  const chosen = names[keyIndex % names.length];
  // A style table pointing at a renamed palette would otherwise reach
  // `undefined` here and take the show down on the next line.
  const fallback = Object.keys(bank)[0];
  const name = bank[chosen] ? chosen : fallback;

  const maxIndex = Array.isArray(colorPresets) && colorPresets.length
    ? colorPresets.length - 1 : Infinity;
  let palette = bank[name].map((i) => Math.min(maxIndex, Math.max(0, i)));

  // Minor keys rotate the palette so major and minor variants of the same key
  // feel different without breaking the look's coherence.
  if (scale === 'minor') {
    if (palette.length === 4) palette = [palette[1], palette[0], palette[3], palette[2]];
    else if (palette.length === 3) palette = [palette[1], palette[2], palette[0]];
    else if (palette.length === 2) palette = [palette[1], palette[0]];
  }

  return { palette, name };
}

/**
 * Walk a palette with maximum spacing — for a 4-colour look the sequence is
 * 0, 2, 1, 3: every entry, never adjacent, before repeating.
 *
 * Plain `idx % len` slides one slot at a time, which on a small palette makes
 * consecutive sections look almost identical.
 */
function goldenStep(index, length) {
  if (!length) return 0;
  // At two colours plain alternation is strictly better: the golden step rounds
  // into back-to-back repeats at i = 2, 3, losing the only property it was for.
  if (length === 2) return index & 1;
  return Math.round(index * length * 0.618033988749895) % length;
}

/**
 * Pick a pattern for a section.
 *
 * `section` needs level / energy / brightness / bass; `available` is the set of
 * pattern ids the rig actually has. `seed` rotates the choice so consecutive
 * sections at the same level do not keep landing on the same pattern — pass the
 * section index, or something derived from its label when repeats should match.
 *
 * `rainbow` is deliberately absent from every pool: it generates its own hues
 * and ignores the colour slots, which would break the track's locked palette.
 */
function pickPattern({ section, seed, available, mood = {}, genreStyle = null }) {
  const brightness = section.brightness || 0;
  const bass = section.bass || 0;
  const energy = section.energy || 0;
  const arousal = mood.arousal || 0;
  const dance = mood.danceability != null ? mood.danceability : 0.5;

  const genrePatterns = genreStyle && genreStyle.patterns
    ? new Set(genreStyle.patterns) : null;

  const pickFrom = (pool) => {
    let filtered = pool.filter((p) => available.has(p));
    if (genrePatterns) {
      const biased = filtered.filter((p) => genrePatterns.has(p));
      if (biased.length) filtered = biased;
    }
    if (dance >= 0.7) {
      const rhythmic = filtered.filter((p) => !FLOWY.has(p));
      if (rhythmic.length) filtered = rhythmic;
    } else if (dance <= 0.35) {
      const flowy = filtered.filter((p) => !RHYTHMIC.has(p));
      if (flowy.length) filtered = flowy;
    }
    if (!filtered.length) return available.has('chase') ? 'chase' : [...available][0];
    return filtered[Math.abs(seed) % filtered.length];
  };

  // High arousal lifts a section into the next pool up: percentile-normalised
  // levels are relative to the track, and a "mid" section of a very energetic
  // track is not a mid section of the evening.
  const level = arousal > 0.8 && section.level === 'mid' ? 'high'
    : arousal > 0.8 && section.level === 'low' ? 'mid' : section.level;

  switch (level) {
    case 'low':
      if (bass < 0.2) return pickFrom(['solid', 'fade', 'wave']);
      return pickFrom(['solid', 'fade', 'wave', 'twinkle']);

    case 'mid':
      if (brightness > 0.45) return pickFrom(['ping-pong', 'wave', 'runner', 'chase', 'sparkle', 'color-cycle']);
      if (bass > 0.4) return pickFrom(['sections', 'split', 'pairs', 'runner', 'stack-up', 'chase']);
      return pickFrom(['chase', 'ping-pong', 'pairs', 'runner', 'wave', 'chase-rev']);

    case 'high': {
      // `hit` punches every fixture in unison on every beat — the loudest thing
      // the rig can do. Gated behind a genuinely high reading, because on a
      // merely "technically high" section it reads as the show shouting.
      const veryHigh = arousal > 0.80 || energy > 0.72;
      const withHit = (pool) => (veryHigh ? pool : pool.filter((p) => p !== 'hit'));
      if (brightness > 0.55) return pickFrom(withHit(['sparkle', 'twinkle', 'random-flash', 'hit']));
      if (bass > 0.5) return pickFrom(withHit(['hit', 'sections', 'pairs', 'stack-up', 'random-flash', 'split']));
      return pickFrom(withHit(['chase', 'runner', 'hit', 'pairs', 'stack-up', 'sections']));
    }

    default:
      return pickFrom(['chase']);
  }
}

/**
 * Strobe speed for a section's own pattern channel, 0 for "no strobe".
 * Only bright or hot sections get one; anywhere else it reads as a blur.
 */
function sectionStrobeSpeed(section) {
  if (section.level !== 'high') return 0;
  const energy = section.energy || 0;
  const brightness = section.brightness || 0;
  if (brightness < 0.3 && energy < 0.65) return 0;
  return Math.round(Math.min(255, 90 + energy * 140 + brightness * 30));
}

/**
 * Which of the fixture's six strobe curves suits a section.
 *
 * Texture, not intensity: the same strobe speed reads completely differently as
 * a stutter, a ramp or a random, and picking by section character is what stops
 * every high section looking like every other one.
 */
function sectionStrobeFunction(section) {
  const brightness = section.brightness || 0;
  const bass = section.bass || 0;
  const energy = section.energy || 0;

  if (section.level === 'high') {
    if (brightness < 0.35 && bass > 0.55 && energy > 0.7) return 'ramp-down-rnd';
    if (brightness > 0.55) return 'random';
    if (bass > 0.55) return 'ramp-up';
    return 'standard';
  }
  if (section.level === 'mid') {
    if (bass > 0.5) return 'ramp-up';
    if (brightness > 0.5) return 'standard';
    return 'ramp-down';
  }
  return 'standard';
}

module.exports = {
  GENRE_STYLES, CIRCUMPLEX_TETRADS, RHYTHMIC, FLOWY,
  styleFor, tierFor, buildPalette, goldenStep, pickPattern,
  sectionStrobeSpeed, sectionStrobeFunction,
};
