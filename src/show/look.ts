// Blend genre evidence so near-tied classifications do not switch the whole show.

import { paletteBankForSize } from '../server/palettes.ts';
import { blend, unit } from './score.ts';
import type { Analysis, Reading, Score } from './score.ts';
import type { BurstKind } from './intents.ts';
import type { Genre, Mood } from '../types/analysis.ts';

export type Tier = 'dance' | 'moderate' | 'rock' | 'calm';

export type Character = Partial<Reading>;

const SUBGENRE_DRIVE: Record<string, number> = {
  edm: 1.0, dubstep: 1.0, trance: 0.9, disco: 0.85,
  hiphop: 0.62, pop: 0.6, funk: 0.62,
  metal: 0.52, rock: 0.46, reggae: 0.4, latin: 0.5, country: 0.34,
  folk: 0.16, jazz: 0.15, ambient: 0.1, classical: 0.05,
};

const TIER_FLOOR: Record<Tier, number> = { dance: 0.72, moderate: 0.55, rock: 0.32, calm: 0 };

// Keep enough palette candidates to vary repeated genres across a set.
const SUBGENRE_PALETTES: Record<string, string[]> = {
  edm:       ['synthwave', 'whiteout', 'aurora', 'strobeLab', 'arctic', 'hardTechno'],
  dubstep:   ['volcanic', 'ultraviolet', 'hardTechno', 'noirUv', 'synthwave', 'acidRave'],
  trance:    ['arctic', 'whiteout', 'violetDream', 'aurora', 'midnight', 'strobeLab'],
  disco:     ['candyPop', 'sunsetDrive', 'iceFire', 'solarPunch', 'peppermint', 'acidRave'],
  hiphop:    ['volcanic', 'ultraviolet', 'desert', 'royal', 'nightDrive', 'midnight'],
  pop:       ['candyPop', 'sunsetDrive', 'tropical', 'iceFire', 'peppermint', 'mint'],
  funk:      ['solarPunch', 'tropical', 'sunsetDrive', 'peppermint', 'acidRave', 'emeraldCity'],
  rock:      ['volcanic', 'solarPunch', 'desert', 'nightDrive', 'iceFire', 'midnight'],
  metal:     ['volcanic', 'noirUv', 'ultraviolet', 'hardTechno', 'royal', 'midnight'],
  country:   ['desert', 'solarPunch', 'sunsetDrive', 'peppermint', 'emeraldCity', 'mint'],
  reggae:    ['emeraldCity', 'tropical', 'solarPunch', 'mint', 'peppermint', 'sunsetDrive'],
  latin:     ['sunsetDrive', 'tropical', 'solarPunch', 'candyPop', 'peppermint', 'iceFire'],
  jazz:      ['royal', 'lunar', 'violetDream', 'midnight', 'nightDrive', 'desert'],
  classical: ['lunar', 'arctic', 'royal', 'midnight', 'whiteout', 'violetDream'],
  folk:      ['desert', 'emeraldCity', 'lunar', 'mint', 'nightDrive', 'sunsetDrive'],
  ambient:   ['deepOcean', 'aurora', 'arctic', 'midnight', 'ultraviolet', 'lunar'],
};

const SUBGENRE_PATTERNS: Record<string, string[]> = {
  edm:       ['pairs', 'runner', 'ensemble', 'split', 'stack-up', 'random-flash', 'hit', 'sections', 'comet', 'burst', 'drums'],
  dubstep:   ['random-flash', 'stack-up', 'split', 'pairs', 'ensemble', 'hit', 'sections', 'burst', 'drums'],
  trance:    ['ribbon', 'sparkle', 'wave', 'twinkle', 'runner', 'ensemble', 'sections', 'gradient', 'plasma', 'stems'],
  disco:     ['ping-pong', 'chase', 'sparkle', 'pairs', 'sections', 'split', 'comet', 'drums'],
  hiphop:    ['pairs', 'split', 'ensemble', 'stack-up', 'runner', 'sections', 'burst', 'drums', 'stems'],
  pop:       ['ping-pong', 'wave', 'ensemble', 'sparkle', 'pairs', 'split', 'gradient', 'comet', 'stems'],
  funk:      ['ping-pong', 'pairs', 'runner', 'chase', 'ensemble', 'sections', 'split', 'comet', 'drums', 'stems'],
  rock:      ['chase', 'runner', 'pairs', 'ping-pong', 'stack-up', 'ensemble', 'comet', 'drums', 'stems'],
  metal:     ['stack-up', 'split', 'random-flash', 'runner', 'pairs', 'hit', 'burst', 'drums'],
  country:   ['wave', 'chase', 'runner', 'ping-pong', 'fade', 'ribbon', 'gradient', 'stems'],
  reggae:    ['wave', 'fade', 'ribbon', 'chase', 'ping-pong', 'pairs', 'gradient', 'stems'],
  latin:     ['ping-pong', 'runner', 'chase', 'pairs', 'wave', 'ensemble', 'comet', 'drums'],
  jazz:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle', 'plasma', 'gradient'],
  classical: ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'gradient'],
  folk:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'gradient'],
  ambient:   ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle', 'plasma', 'gradient'],
};

// Give each bank a distinct mood-word pair so mood scoring can distinguish all banks.
const SEMANTIC_PALETTES: Record<string, [string, string]> = {
  desert:      ['warm', 'organic'],
  lunar:       ['intimate', 'ceremonial'],
  deepOcean:   ['spacious', 'suspended'],
  arctic:      ['cold', 'mechanical'],
  volcanic:    ['aggressive', 'dark'],
  solarPunch:  ['euphoric', 'triumphant'],
  synthwave:   ['mechanical', 'dark'],
  sunsetDrive: ['warm', 'suspended'],
  emeraldCity: ['organic', 'triumphant'],
  violetDream: ['suspended', 'intimate'],
  candyPop:    ['euphoric', 'warm'],
  halloween:   ['dark', 'organic'],
  noirUv:      ['dark', 'cold'],
  royal:       ['ceremonial', 'triumphant'],
  tropical:    ['warm', 'spacious'],
  aurora:      ['spacious', 'cold'],
  whiteout:    ['cold', 'euphoric'],
  strobeLab:   ['mechanical', 'triumphant'],
  hardTechno:  ['aggressive', 'mechanical'],
  ultraviolet: ['dark', 'suspended'],
  acidRave:    ['aggressive', 'euphoric'],
  iceFire:     ['cold', 'aggressive'],
  midnight:    ['dark', 'spacious'],
  peppermint:  ['triumphant', 'warm'],
  mint:        ['organic', 'cold'],
  nightDrive:  ['mechanical', 'spacious'],
};

const CIRCUMPLEX_TETRADS = {
  highPos: ['sunsetDrive', 'candyPop', 'tropical', 'solarPunch'],
  highNeg: ['volcanic', 'noirUv', 'halloween', 'synthwave'],
  lowPos:  ['desert', 'emeraldCity', 'lunar', 'royal'],
  lowNeg:  ['deepOcean', 'arctic', 'aurora', 'lunar'],
};

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Parse the pitch class separately because analysed keys also include their mode.
const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

function keyIndexOf(key: unknown): number {
  const token = String(key == null ? '' : key).trim().split(/[\s/|-]+/)[0];
  if (!token) return 0;
  const pitch = token[0].toUpperCase() + token.slice(1).replace(/[^#b]/g, '');
  return Math.max(0, KEYS.indexOf(FLATS[pitch] || pitch));
}

const RHYTHMIC = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong',
  'split', 'sections', 'stack-up', 'random-flash', 'hit', 'color-cycle', 'comet', 'burst', 'drums']);
const FLOWY = new Set(['solid', 'fade', 'wave', 'sparkle', 'twinkle', 'gradient', 'plasma']);
const PULSE_PATTERNS = new Set(['drums', 'stems']);
const EXPRESSIVE = new Set(['ensemble', 'ribbon']);

// Measured energy remains a floor even when the classifier confidently names a quiet genre.
const STYLE_DRIVE: Record<string, number> = { dance: 0.85, moderate: 0.6, rock: 0.42, calm: 0.12 };

function driveFor(analysis: Analysis | null | undefined, mood: Partial<Mood> | null | undefined,
  score: Score | null | undefined): {
  drive: number;
  tier: Tier;
  measured: number;
  classified: number | null;
  trust: number;
} {
  const arousal = unit(mood && mood.arousal, 0.5);
  const dance = unit(mood && mood.danceability, 0.5);
  const measured = unit(0.15 + arousal * 0.55 + dance * 0.3);

  const votes = blend(score ? score.subgenre : {}, SUBGENRE_DRIVE);
  let classified: number | null = null;
  let trust = 0;
  if (votes.size) {
    let sum = 0;
    let total = 0;
    for (const [value, weight] of votes) { sum += value * weight; total += weight; }
    if (total > 0) {
      classified = sum / total;
      trust = unit(score && score.genreTrust);
    }
  } else {
    const genre: Partial<Genre> = (analysis && analysis.genre) || {};
    const fromStyle = STYLE_DRIVE[String(genre.style)];
    if (fromStyle != null) {
      classified = fromStyle;
      trust = unit(genre.confidence ?? genre.labelConf, 0.6) * 0.9;
    }
  }

  const drive = classified == null ? measured
    : classified * trust + measured * (1 - trust);
  const floored = Math.max(drive, measured * 0.65);
  return { drive: unit(floored), tier: tierOf(floored), measured, classified, trust };
}

function tierOf(drive: number): Tier {
  return drive >= TIER_FLOOR.dance ? 'dance'
    : drive >= TIER_FLOOR.moderate ? 'moderate'
      : drive >= TIER_FLOOR.rock ? 'rock' : 'calm';
}

function buildPalette({ key, scale, mood = {}, score = null, paletteSize = 4,
  colorPresets = null, avoid = null, continueFrom = null, lock = null }: {
  key?: string | null;
  scale?: string | null;
  mood?: Partial<Mood>;
  score?: Score | null;
  paletteSize?: number;
  colorPresets?: readonly unknown[] | null;
  avoid?: string | null;
  continueFrom?: readonly number[] | null;
  lock?: string | null;
}): { palette: number[]; name: string } {
  const bank: Record<string, number[]> = paletteBankForSize(paletteSize);
  const scores = new Map<string, number>();
  const add = (name: string, weight: number) => {
    if (!bank[name] || !(weight > 0)) return;
    scores.set(name, (scores.get(name) || 0) + weight);
  };

  const keyIndex = keyIndexOf(key);

  const trust = unit(score && score.genreTrust);
  if (score && trust > 0) {
    const votes = blend(score.subgenre, SUBGENRE_PALETTES,
      (name, subgenre, ranked) => {
        const rank = (ranked.indexOf(name) - keyIndex + ranked.length * 2) % ranked.length;
        return 1 / (1 + rank);
      });
    for (const [name, weight] of votes) add(name, weight * trust * 3.0);
  }

  const semantic: Record<string, number> = (score && score.semantic) || {};
  for (const [name, [first, second]] of Object.entries(SEMANTIC_PALETTES)) {
    const agreement = Math.min(unit(semantic[first]), unit(semantic[second]));
    if (agreement >= 0.5) add(name, (agreement - 0.4) * 1.6);
  }

  const valence = mood.valence != null ? mood.valence : (scale === 'major' ? 0.65 : 0.35);
  const arousal = mood.arousal != null ? mood.arousal : 0.5;
  const quadrant = arousal >= 0.5
    ? (valence >= 0.5 ? CIRCUMPLEX_TETRADS.highPos : CIRCUMPLEX_TETRADS.highNeg)
    : (valence >= 0.5 ? CIRCUMPLEX_TETRADS.lowPos : CIRCUMPLEX_TETRADS.lowNeg);
  const strongestPair = Math.max(0, ...Object.values(SEMANTIC_PALETTES)
    .map(([first, second]) => Math.min(unit(semantic[first]), unit(semantic[second]))));
  const unexplained = Math.max(0.25, 1 - trust - strongestPair);
  quadrant.forEach((name, i) => add(name,
    (i === keyIndex % quadrant.length ? 0.5 : 0.18) * unexplained));

  // Avoid the previous bank while favouring shared colours for harmonically compatible tracks.
  if (continueFrom && continueFrom.length) {
    for (const name of scores.keys()) {
      const shared = bank[name].filter((i) => continueFrom.includes(i)).length;
      if (shared) scores.set(name, (scores.get(name) || 0) + shared / bank[name].length);
    }
  }
  if (avoid) scores.delete(avoid);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]
    || a[0].localeCompare(b[0]));

  // Do not apply the key again when breaking palette ties; it already shaped the ranking.
  const name = lock && bank[lock] ? lock
    : ranked.length ? ranked[0][0]
      : Object.keys(bank).find((n) => n !== avoid) || Object.keys(bank)[0];

  const maxIndex = Array.isArray(colorPresets) && colorPresets.length
    ? colorPresets.length - 1 : Infinity;
  let palette = bank[name].map((i) => Math.min(maxIndex, Math.max(0, i)));

  if (scale === 'minor') {
    if (palette.length === 4) palette = [palette[1], palette[0], palette[2], palette[3]];
    else if (palette.length === 3) palette = [palette[1], palette[2], palette[0]];
    else if (palette.length === 2) palette = [palette[1], palette[0]];
  }

  return { palette, name };
}

// Distinct section identities limit colour count so each colour can retain a musical role.
function paletteSizeFor({ score = null, identities = 0, mood = {} }: {
  score?: Score | null;
  identities?: number;
  mood?: Partial<Mood>;
} = {}): number {
  const wanted = Math.max(2, Math.min(4, identities || 2));
  const support = 0.45 * unit(score && score.keyStrength, 0.5)
    + 0.3 * unit(score && score.width, 0.5)
    + 0.25 * unit(mood.valence, 0.5);
  const size = support < 0.38 ? wanted - 1 : wanted;
  return Math.max(2, Math.min(4, size));
}

// Skip adjacent palette entries so consecutive sections remain visually distinct.
function goldenStep(index: number, length: number): number {
  if (!length) return 0;
  if (length === 2) return index & 1;
  return Math.round(index * length * 0.618033988749895) % length;
}

function pickPattern({ character, available, score = null, seed = 0, drive = 0.5,
  dance = 0.5, pixels = false, pictures = null, avoid = null }: {
  character?: Character | null;
  available: ReadonlySet<string>;
  score?: Score | null;
  seed?: number;
  drive?: number;
  dance?: number;
  pixels?: boolean;
  pictures?: ReadonlySet<string> | null;
  avoid?: ReadonlySet<string> | null;
}): string {
  const c: Character = character || {};
  const low = unit(c.kick) * 0.6 + unit(c.bassline) * 0.4;
  const voice = unit(c.vocal);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const energy = unit(c.energy, 0.4);
  const pulse = unit(c.pulse, 0.4);

  const genrePool = new Set([...blend(score ? score.subgenre : {}, SUBGENRE_PATTERNS).keys()]);
  const trust = unit(score && score.genreTrust);

  const pictured = (pixelPool: string[]) => (pixels ? pixelPool : pictures ? pixelPool.filter((p) => pictures.has(p)) : []);
  const pickFrom = (pool: string[], pixelPool: string[] = []): string => {
    let filtered = [...pool, ...pictured(pixelPool)].filter((p) => available.has(p));
    if (trust >= 0.25 && genrePool.size) {
      const biased = filtered.filter((p) => genrePool.has(p));
      if (biased.length) filtered = biased;
    }
    if (dance >= 0.55) {
      const rhythmic = filtered.filter((p) => !FLOWY.has(p));
      if (rhythmic.length) filtered = rhythmic;
    } else if (dance <= 0.3) {
      const flowy = filtered.filter((p) => !RHYTHMIC.has(p));
      if (flowy.length) filtered = flowy;
    }
    if (avoid && avoid.size) {
      const fresh = filtered.filter((p) => !avoid.has(p));
      const wide = [...pool, ...pictured(pixelPool)].filter((p) => available.has(p) && !avoid.has(p));
      if (fresh.length) filtered = fresh;
      else if (wide.length) filtered = wide;
    }
    if (!filtered.length) {
      return available.has('ribbon') ? 'ribbon'
        : available.has('chase') ? 'chase' : [...available][0];
    }
    return filtered[Math.abs(Math.round(seed)) % filtered.length];
  };

  // Quiet: nothing is carrying the passage, so nothing should be chasing.
  if (energy < 0.25 || drive < 0.22) {
    return pickFrom(['ribbon', 'fade', 'solid', 'wave', 'twinkle'], ['gradient', 'plasma']);
  }

  if (voice > low + 0.12) {
    return drive >= 0.5 || energy >= 0.5
      ? pickFrom(['pairs', 'sections', 'ensemble', 'split', 'ping-pong', 'runner', 'chase'], ['comet', 'stems'])
      : pickFrom(['ensemble', 'ribbon', 'wave', 'fade', 'twinkle', 'solid'], ['gradient']);
  }

  if (low >= 0.4 && pulse >= 0.5) {
    const hard = drive >= 0.75 && (energy > 0.7 || pulse > 0.75);
    return hard
      ? pickFrom(['hit', 'stack-up', 'sections', 'pairs', 'split', 'random-flash', 'ensemble'], ['burst', 'comet', 'drums'])
      : pickFrom(['pairs', 'sections', 'ensemble', 'runner', 'split', 'chase', 'stack-up'], ['comet', 'burst', 'drums']);
  }

  // Top-heavy: shimmer rather than punch.
  if (air > 0.45 && air > low) {
    return pickFrom(['sparkle', 'twinkle', 'ensemble', 'ribbon', 'wave', 'random-flash'], ['plasma']);
  }

  // Travelling patterns supply movement when the rig has no moving heads.
  return pickFrom(['chase', 'runner', 'ping-pong', 'pairs', 'ensemble', 'ribbon', 'wave', 'color-cycle'], ['comet', 'gradient', 'stems']);
}

const PAR_PICTURES: ReadonlySet<string> = new Set(['gradient', 'plasma', 'comet', 'burst']);
const PAR_PICTURES_WITH_DRUMS: ReadonlySet<string> = new Set([...PAR_PICTURES, 'drums']);

function availableFor(patterns: readonly { id: string }[], analysis: { pulse?: unknown } | null | undefined): Set<string> {
  const ids = new Set(patterns.map((p) => p.id));
  if (!analysis || !analysis.pulse) for (const id of PULSE_PATTERNS) ids.delete(id);
  return ids;
}

function strobeFunctionFor(character: Character | null | undefined, score: Score | null | undefined): string {
  const c: Character = character || {};
  const articulation = unit(score && score.articulation, 0.5);
  const air = unit(c.texture);
  const low = unit(c.kick) * 0.6 + unit(c.bassline) * 0.4;

  if (articulation > 0.62 && low > 0.5) return air > 0.55 ? 'random' : 'ramp-down-rnd';
  if (air > 0.6) return 'random';
  if (low > 0.5) return 'ramp-up';
  if (articulation < 0.35) return 'ramp-down';
  return 'standard';
}

function strobeSpeedFor(character: Character | null | undefined, score: Score | null | undefined,
  drive: number): number {
  const c: Character = character || {};
  const energy = unit(c.energy);
  const articulation = unit(score && score.articulation, 0.5);
  if (drive < 0.5 || energy < 0.45 || articulation < 0.35) return 0;
  const air = unit(c.texture);
  return Math.round(Math.min(255, 80 + energy * 130 + air * 45) * Math.min(1.2, drive));
}

function burstFor({ moment = 'accent', character, score, drive,
  headroom = true, vocal = false }: {
  moment?: 'accent' | 'drop';
  character?: Character | null;
  score?: Score | null;
  drive: number;
  headroom?: boolean;
  vocal?: boolean;
}): BurstKind {
  const c: Character = character || {};
  const semantic: Record<string, number> = (score && score.semantic) || {};
  const energy = unit(c.energy);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const articulation = unit(score && score.articulation, 0.5);
  const triumphant = Math.max(unit(semantic.triumphant), unit(semantic.euphoric));
  const aggressive = Math.max(unit(semantic.aggressive), unit(semantic.dark));

  if (moment === 'drop') {
    if (drive < 0.45 || energy < 0.3) return 'glow';
    if (drive < 0.72) return 'color-strobe';
    const cold = (air > 0.5 || aggressive > 0.55) && triumphant <= aggressive;
    return cold ? 'white-strobe' : 'blinder';
  }

  if (drive < 0.32 || energy < 0.3) return 'glow';
  if (vocal) return drive >= 0.75 && energy > 0.65 ? 'kill' : 'glow';
  if (articulation >= 0.5) return 'kill';
  if (aggressive > 0.55 && drive >= 0.5) return 'uv-wash';
  // Compressed masters need contrast from darkness rather than another bright accent.
  if (!headroom) return drive >= 0.55 ? 'kill' : 'glow';
  if (drive < 0.45) return 'glow';
  if (drive < 0.6) return 'kill';
  return 'color-strobe';
}

export {
  SUBGENRE_DRIVE,
  SUBGENRE_PALETTES,
  SUBGENRE_PATTERNS,
  SEMANTIC_PALETTES,
  CIRCUMPLEX_TETRADS,
  TIER_FLOOR,
  RHYTHMIC,
  FLOWY,
  EXPRESSIVE,
  PULSE_PATTERNS,
  availableFor,
  PAR_PICTURES,
  PAR_PICTURES_WITH_DRUMS,
  driveFor,
  tierOf,
  buildPalette,
  paletteSizeFor,
  goldenStep,
  pickPattern,
  keyIndexOf,
  strobeFunctionFor,
  strobeSpeedFor,
  burstFor,
};
