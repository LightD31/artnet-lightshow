import { EVENT, deriveEvents, byType } from './musical-events.ts';
import * as look from './look.ts';
import { makeScore, hasScore, cosine, unit, list, finite } from './score.ts';
import { INTENT, BURST, PRIORITY, scene, expression, color, accent, tempo, dark } from './intents.ts';
import type { AccentIntent, Intent, SceneIntent } from './intents.ts';
import type { ShowEvent } from './musical-events.ts';
import type { Analysis, Segment } from './score.ts';
import type { Drop, Genre, Mood, Section } from '../types/analysis.ts';
import { arcFor, keysMix } from './set-memory.ts';
import { applyOverlay } from './overlay.ts';
import type { ShowOverlay } from './overlay.ts';
import type { SetHistory, TrackMemory } from './set-memory.ts';

export type DirectorAnalysis = Analysis & {
  mood: Partial<Mood>;
  genre: Genre | null;
};

export interface RoleProfile {
  levelBias: number;
  accents: boolean;
  maxDivision: number;
  prefer: string[] | null;
}

export interface PatternDescriptor {
  id: string;
  [key: string]: unknown;
}

export interface DirectorOptions {
  patterns?: readonly PatternDescriptor[];
  colorPresets?: readonly unknown[] | null;
  paletteSize?: number | 'auto';
  intensity?: number;
  blackoutIndex?: number;
  pixels?: boolean;
  panels?: boolean;
  lamps?: number | null;
  history?: SetHistory | null;
  overlay?: ShowOverlay | null;
}

export type PlannedSection = ReturnType<ShowDirector['_sections']>[number];

export type PlanContext = ReturnType<ShowDirector['_context']>;

export interface Plan {
  intents: Intent[];
  palette: number[];
  paletteName: string;
  paletteSize: number;
  context: PlanContext;
  memory: Omit<TrackMemory, 'key' | 'at'>;
}

export interface BuildupMeasure {
  rollRatio: number | null;
  riseDivision: number | null;
  peakDivision: number | null;
  tempo: {
    points: { tMs: number; bpm: number }[];
    settleBpm: number;
    fromBpm: number;
    toBpm: number;
  } | null;
}

const field = (o: object, key: string): unknown => (o as Record<string, unknown>)[key];

// Match patch-schema tempo bounds so timer-driven patches cannot throw on an invalid BPM.
const clampBpm = (n: number | undefined): number => Math.max(20, Math.min(300, Math.round((n as number) * 100) / 100 || 120));
const u8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n) || 0));

const TEMPO_RAMP_MIN_BPM = 3;

const DRIFT_THRESHOLD = 0.60;

// Role policy columns: levelBias = weight adjustment; accents = allowed bar accents;
// maxDivision = subdivision ceiling; prefer = preferred available patterns.
const ROLE_PROFILE: Record<string, RoleProfile> = {
  intro:     { levelBias: -0.18, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave', 'solid'] },
  verse:     { levelBias: 0,     accents: true,  maxDivision: 2, prefer: null },
  prechorus: { levelBias: 0.06,  accents: true,  maxDivision: 2, prefer: null },
  instrumental: { levelBias: 0.06, accents: true, maxDivision: 4, prefer: null },
  chorus:    { levelBias: 0.12,  accents: true,  maxDivision: 4, prefer: null },
  drop:      { levelBias: 0.15,  accents: true,  maxDivision: 4, prefer: null },
  bridge:    { levelBias: 0,     accents: true,  maxDivision: 2, prefer: null },
  breakdown: { levelBias: -0.20, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave'] },
  outro:     { levelBias: -0.18, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave', 'solid'] },
  unknown:   { levelBias: 0,     accents: true,  maxDivision: 4, prefer: null },
};

const RESTING_ROLES = new Set(['intro', 'outro', 'breakdown']);

const LEVEL_WEIGHT: Record<string, number> = { low: 0.2, mid: 0.5, high: 0.82 };

const ACCENT_BUDGET: Record<string, number> = { dance: 20, moderate: 12, rock: 7, calm: 0, unknown: 10 };

// Reserve quiet in musical bars so the drop’s contrast survives tempo changes.
const DROP_GUARD_BARS = 1;
const DROP_GUARD_SEC = { min: 1.5, max: 4, fallback: 2 };
const BAR_JITTER = 0.05;

const SECTION_FADE_BARS: Record<string, number> = { breakdown: 2, outro: 2, intro: 1, verse: 0.5, prechorus: 0.5, instrumental: 0.5, bridge: 0.5, chorus: 0, drop: 0 };
const CUT_ROLES = new Set(['chorus', 'drop']);
const SPLITTABLE = new Set(['chase', 'chase-rev', 'ping-pong', 'runner', 'pairs', 'wave',
  'stack-up', 'twinkle', 'sparkle', 'random-flash', 'comet', 'burst']);
const SPLIT_DRIVE = 0.5;

const MAX_FADE_MS = 4000;

const MIN_BURST_MS = 300;

// Sample twice a second to bound timeline size; the renderer interpolates between samples.
const EXPRESSION_STEP_SEC = 0.5;

// Use only measured reliable drum lanes so weak detections cannot invent accents.
const DRUM_DETECTOR = 2;
const STRONG_HIT = 0.7;
const HIT_SNAP_SEC = 0.08;
const FILL_HITS = 3;

const IDENTITY_SIMILARITY = 0.94;

class ShowDirector {
  declare patterns: readonly PatternDescriptor[];
  declare colorPresets: readonly unknown[] | null;
  declare paletteSize: number | 'auto';
  declare intensity: number;
  declare blackoutIndex: number;
  declare pixels: boolean;
  declare panels: boolean;
  declare lamps: number | null;
  declare history: SetHistory | null;
  declare overlay: ShowOverlay | null;

  /**
   * @param {object} options
   * @param {Array}  options.patterns      pattern descriptors the rig supports
   * @param {Array}  options.colorPresets  the colour table, for palette bounds
   * @param {number|'auto'} options.paletteSize  2 | 3 | 4, or 'auto' to let the
   *                                             music decide
   * @param {number} options.intensity     0..100 operator fader
   * @param {number} options.blackoutIndex colour index that means "off"
   */
  constructor({ patterns = [], colorPresets = null, paletteSize = 4,
    intensity = 50, blackoutIndex = 0, pixels = false, panels = false, lamps = null, history = null,
    overlay = null }: DirectorOptions = {}) {
    this.patterns = patterns;
    this.colorPresets = colorPresets;
    this.paletteSize = paletteSize;
    this.intensity = intensity;
    this.blackoutIndex = blackoutIndex;
    this.pixels = !!pixels;
    this.panels = !!panels;
    this.lamps = Number.isFinite(lamps) ? lamps : null;
    this.history = history;
    this.overlay = overlay;
  }

  plan(analysis: Analysis | null | undefined): Plan {
    const context = this._context(normalise(analysis));

    const planned = [
      ...this._openingIntent(context),
      ...this._planTempo(context),
      ...this._planSections(context),
      ...this._planExpression(context),
      ...this._planBuildups(context),
      ...this._planDrops(context),
      ...this._planQuiet(context),
      ...this._planColourMoves(context),
    ];
    // Reserve planned bursts before accents so accents cannot interrupt them.
    const booked = planned.filter((i): i is AccentIntent => i.kind === INTENT.ACCENT);
    const intents: Intent[] = [...planned, ...this._applyContrast(this._planAccents(context), context, booked)];

    // Apply stronger intents last when timestamps tie.
    intents.sort((a, b) => a.timeMs - b.timeMs || a.priority - b.priority);

    if (context.pixels) this._mapPixels(intents, context);
    if (context.panels) this._mapPanels(intents, context);
    // Apply operator edits before geometry adaptation so authored travelling looks can still be mirrored.
    const edited = this.overlay ? applyOverlay(intents, this.overlay, context.sections) : intents;
    if (!context.pixels) this._mapPars(edited, context);

    const looks: Record<string, string> = {};
    for (const i of edited) {
      if (i.kind === INTENT.SCENE && i.pattern && i.role && String(i.source).startsWith('section:') && !(i.role in looks)) {
        looks[i.role] = i.pattern;
      }
    }
    return {
      intents: this._dedupeTempo(edited),
      palette: context.palette,
      paletteName: context.paletteName,
      paletteSize: context.paletteSize,
      context,
      memory: {
        paletteName: context.paletteName,
        palette: context.palette,
        looks,
        drive: context.drive,
        musicalKey: context.musicalKey,
        blinder: edited.some((i) => i.kind === INTENT.ACCENT && i.burst === BURST.BLINDER),
      },
    };
  }

  _mapPixels(intents: Intent[], context: PlanContext): void {
    const { available } = context;
    const ordinal = new Map<string, number>();
    const next = (key: string) => {
      const n = ordinal.get(key) || 0;
      ordinal.set(key, n + 1);
      return n;
    };
    for (const intent of intents) {
      if (intent.kind !== INTENT.SCENE || !intent.pattern) continue;
      const t = intent.timeMs / 1000;
      const source = String(intent.source);
      const section = this._sectionOf(intent, context);
      delete intent.split;

      if (source === 'drop:anchor') {
        intent.pixelPattern = null;
        intent.pixelMap = 'stage';
        continue;
      }
      const build = source.startsWith('buildup:')
        ? context.buildups.find((b) => t >= b.t - 0.25 && t <= endOf(b) + 0.25) : undefined;
      if (build) {
        // Carry fill progress across scenes so a build remains one continuous gesture.
        const look = barLook(['rise', 'comet'], available);
        this._placeBars(intent, look, 'mirror', context, build.t, endOf(build));
        if (source === 'buildup:rise' && available.has('hit')) intent.pattern = 'hit';
        continue;
      }
      if (source.startsWith('drop:')) {
        // Advance drop programs so repeated drops do not always reuse the first.
        const drop = context.drops.filter((d) => d.t <= t + 0.25).length;
        const strobe = strobeLook(DROP_STROBES, drop + context.trackSeed, available);
        if (strobe) this._placeBars(intent, strobe, STROBE_MAPS[strobe], context);
        else this._placeBars(intent, barLook(['impact', 'burst', 'comet'], available), 'stage', context);
        intent.pattern = parWash(1, next(`drop:${source}`) + context.trackSeed, available) || intent.pattern;
        continue;
      }
      if (source === 'break') {
        this._placeBars(intent, barLook(['plasma', 'gradient'], available), 'stage', context);
        continue;
      }

      const role = section ? section.role : 'unknown';
      const table = PIXEL_ROLE_LOOKS[role];
      const strobe = section && !section.resting && section.drive >= STROBE_DRIVE && STROBE_ROLES.has(role)
        ? strobeLook(DRIVING_STROBES, section.identity + context.trackSeed, available) : null;
      if (strobe) {
        this._placeBars(intent, strobe, STROBE_MAPS[strobe], context);
      } else if (table) {
        const look = barLook(table.map((l) => l.pattern), available);
        const map = (table.find((l) => l.pattern === look) || table[0]).map;
        this._placeBars(intent, look, map, context,
          ...(look === 'rise' && section ? [section.start, section.end] as const : []));
      } else {
        const identity = section ? section.identity : 0;
        const look = CELL_LOOKS.has(intent.pattern) && available.has(intent.pattern)
          ? intent.pattern : barLook(['comet', 'gradient'], available);
        this._placeBars(intent, look, PIXEL_MAPS[Math.abs(identity * 5 + context.trackSeed) % PIXEL_MAPS.length], context);
      }
      if (section && !section.resting && !RESTING_LOOKS.includes(intent.pattern)) {
        const turn = next(`section:${section.index}`);
        intent.pattern = parWash(section.drive, section.identity + turn * 7 + context.trackSeed, available) || intent.pattern;
      }
    }
  }

  _mapPanels(intents: Intent[], context: PlanContext): void {
    const { available } = context;
    for (const intent of intents) {
      if (intent.kind !== INTENT.SCENE || !intent.pattern) continue;
      const source = String(intent.source);
      if (source === 'drop:anchor') {
        intent.panelPattern = null;
        continue;
      }
      const section = this._sectionOf(intent, context);
      const role = source.startsWith('buildup:') ? 'buildup'
        : source.startsWith('drop:') ? 'drop'
          : source === 'break' ? 'breakdown'
            : section ? section.role : 'unknown';
      const table = PANEL_ROLE_LOOKS[role];
      if (table) {
        intent.panelPattern = barLook(table, available);
        continue;
      }
      const pool = PANEL_LOOKS.filter((p) => available.has(p));
      intent.panelPattern = pool.length
        ? pool[Math.abs((section ? section.identity : 0) + context.trackSeed) % pool.length] : null;
    }
  }

  _mapPars(intents: Intent[], context: PlanContext): void {
    const { available } = context;
    for (const intent of intents) {
      if (intent.kind !== INTENT.SCENE || !intent.pattern) continue;
      const source = String(intent.source);
      if (source === 'buildup:rise' && available.has('stack-up')) intent.pattern = 'stack-up';
      const section = this._sectionOf(intent, context);
      const symmetric = source === 'buildup:rise'
        || (source.startsWith('drop:') && source !== 'drop:anchor')
        || (!source.startsWith('buildup:') && source !== 'break' && !!section && MIRRORED_ROLES.has(section.role));
      intent.pixelMap = symmetric && MIRRORED_LOOKS.has(intent.pattern) ? 'mirror' : 'stage';
    }
  }

  _sectionOf(intent: SceneIntent, context: PlanContext): PlannedSection | null {
    const source = String(intent.source);
    return (source.startsWith('section:')
      && context.sections.find((s) => Math.abs(context.snapToDownbeatMs(s.start) - intent.timeMs) < 1))
      || context.sectionAt(intent.timeMs / 1000);
  }

  _placeBars(intent: SceneIntent, look: string | null, map: string, context: PlanContext,
    from?: number, to?: number): void {
    intent.pixelPattern = look;
    intent.pixelMap = map;
    if (look === 'rise' && from !== undefined && to !== undefined && to > from) {
      const t = intent.timeMs / 1000;
      intent.pixelSpan = Math.max(1, beatsBetween(context, from, to));
      intent.pixelFrom = unit((t - from) / (to - from));
    }
  }

  _context(analysis: DirectorAnalysis) {
    const events = deriveEvents(analysis);
    const grouped = byType(events);
    const mood: Partial<Mood> = analysis.mood || {};
    const score = makeScore(analysis);

    const { drive, tier } = look.driveFor(analysis, mood, score);
    const factor = this.intensity / 50;  // 0 … 2, with 50 as "normal"

    // Cap scaled drive so the intensity fader cannot exceed the music’s allowance.
    const effective = unit(drive * Math.min(1.35, Math.max(0, factor)));
    // A pushed fader may unlock drops on quiet tracks, but never increases their zero accent budget.
    const isCalm = this.intensity === 0 || (effective < 0.3 && factor < 1.4);
    const isLight = !isCalm && effective < 0.45;

    const sections = this._sections(analysis, { score, drive, isCalm });
    const identities = new Set(sections.map((s) => s.identity)).size;

    const paletteSize: number = this.paletteSize === 'auto'
      ? look.paletteSizeFor({ score, identities, mood })
      : this.paletteSize;
    const previous = this.history?.previous ?? null;
    const musicalKey = analysis.key ? [analysis.key, analysis.scale].filter(Boolean).join(' ') : null;
    const mixes = !!previous && keysMix(previous.musicalKey, musicalKey);
    const { palette, name: paletteName } = look.buildPalette({
      key: analysis.key, scale: analysis.scale, mood, score,
      paletteSize, colorPresets: this.colorPresets,
      avoid: previous ? previous.paletteName : null,
      continueFrom: mixes ? previous.palette : null,
      lock: this.overlay?.palette ?? null,
    });
    const arc = arcFor(this.history, drive);

    const meter = analysis.meter || 4;
    const downbeats = list(analysis.downbeats);
    // Use the median bar length because pickups make the first downbeat gap unreliable.
    const barSec = medianGap(downbeats);
    const baseBpm = clampBpm(analysis.bpm);
    const duration = Math.max(0, finite(analysis.duration,
      Math.max(0, ...sections.map((s) => s.end))));

    return {
      analysis, events, grouped, mood, score, drive, tier, factor, effective,
      isCalm, isLight, palette, paletteName, paletteSize, meter, downbeats,
      arc, musicalKey, keyMixes: mixes,
      previousLooks: previous ? previous.looks : {},
      barSec, baseBpm, duration, sections, identities,
      trackSeed: trackSeedOf(analysis),
      finalReturns: lastReturns(sections),
      continuous: hasScore(analysis),
      available: look.availableFor(this.patterns, analysis),
      pixels: this.pixels,
      panels: this.pixels && this.panels,
      pictures: this.pixels ? null
        : drumHitsOf(analysis) && (this.lamps === null || this.lamps >= 3) ? look.PAR_PICTURES_WITH_DRUMS : look.PAR_PICTURES,
      drops: grouped.get(EVENT.DROP) || [],
      buildups: grouped.get(EVENT.BUILDUP) || [],
      bars: grouped.get(EVENT.BAR) || [],
      beats: grouped.get(EVENT.BEAT) || [],
      vocals: grouped.get(EVENT.VOCAL_SECTION) || [],
      silences: grouped.get(EVENT.SILENCE) || [],
      breaks: grouped.get(EVENT.BREAK) || [],
      melodies: grouped.get(EVENT.MELODY_CHANGE) || [],
      spikes: grouped.get(EVENT.ENERGY_SPIKE) || [],
      bassHits: grouped.get(EVENT.BASS_HIT) || [],
      drums: drumHitsOf(analysis),
      snapToDownbeatMs: this._snapper(downbeats, barSec),
      barsAfterMs: barWalker(downbeats, barSec),
      fadeMs: (bars: number) => Math.round(Math.min(MAX_FADE_MS, bars * (barSec || 2) * 1000)),
      sectionAt: (t: number) => sections.find((s) => t >= s.start && t < s.end) || null,
    };
  }

  _sections(analysis: DirectorAnalysis, { score, drive, isCalm }: {
    score: ReturnType<typeof makeScore>;
    drive: number;
    isCalm: boolean;
  }) {
    const raw = splitRestingAtDrops(list(analysis.segments), list(analysis.drops));
    if (!raw.length) return [];

    // Absolute energy corrects percentile labels that underrate consistently energetic passages.
    const memories: { label: string | null | undefined; vector: number[] | undefined; identity: number }[] = [];
    return raw.map((section, index) => {
      const role = section.role || 'unknown';
      const profile = ROLE_PROFILE[role] || ROLE_PROFILE.unknown;
      const start = finite(section.start);
      const end = Math.max(start, finite(section.end));
      const character = score.span(start, end);
      const vector = score.vector(start, end);

      const match = memories.find((m) => (section.label != null && m.label === section.label)
        || (vector && m.vector && cosine(vector, m.vector) > IDENTITY_SIMILARITY));
      const identity = match ? match.identity : memories.length;
      if (!match) memories.push({ label: section.label, vector, identity });

      // Combine measured energy with relative section levels to retain both absolute and within-track contrast.
      const fromLevel = section.level ? LEVEL_WEIGHT[section.level] : undefined;
      const measured = unit(character.energy, 0.45);
      let weight = fromLevel == null ? measured : measured * 0.65 + fromLevel * 0.35;
      weight = unit(weight + profile.levelBias);
      if (isCalm) weight = Math.min(weight, 0.5);

      return {
        ...section,
        index, role, profile, identity, character, vector,
        weight,
        rawLevel: section.level,
        // Retain levels for the segment schema and operator views.
        level: (weight >= 0.68 ? 'high' : weight >= 0.36 ? 'mid' : 'low') as Section['level'],
        resting: RESTING_ROLES.has(role) || weight < 0.18,
        start,
        end,
        drive: unit(drive * (0.55 + weight * 0.6)),
      };
    });
  }

  _snapper(downbeats: readonly number[], barSec: number | null): (t: number) => number {
    if (!downbeats.length || !barSec) return (t) => Math.round(t * 1000);
    return (t) => {
      let lo = 0;
      let hi = downbeats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (downbeats[mid] < t) lo = mid + 1; else hi = mid;
      }
      let best = downbeats[lo];
      for (const candidate of [downbeats[lo - 1], downbeats[lo], downbeats[lo + 1]]) {
        if (candidate != null && Math.abs(candidate - t) < Math.abs(best - t)) best = candidate;
      }
      return Math.abs(best - t) <= barSec * 0.5
        ? Math.round(best * 1000) : Math.round(t * 1000);
    };
  }

  _openingIntent(context: PlanContext): Intent[] {
    return [scene(0, {
      bpm: context.baseBpm,
      beatDivision: 1,
      running: true,
      strobeSpeed: 0,
      strobeFunction: 'standard',
      opening: true,
    }, { source: 'opening', priority: PRIORITY.SECTION })];
  }

  // Skip tempo drift for stable tracks to avoid jittering the beat clock.
  _planTempo(context: PlanContext): Intent[] {
    const { analysis } = context;
    const stability = finite(analysis.tempoStability, 1);
    const curve = list(analysis.tempoCurve);
    if (stability >= DRIFT_THRESHOLD || curve.length <= 2) return [];

    const intents: Intent[] = [];
    let last = context.baseBpm;
    for (const point of curve) {
      const bpm = Math.round(point.v);
      if (Math.abs(bpm - last) < 4) continue;      // movement floor
      if (bpm < 50 || bpm > 220) continue;         // likely an octave error
      intents.push(tempo(point.t * 1000, bpm, { source: 'drift' }));
      last = bpm;
    }
    return intents;
  }

  // Key looks by section identity so a returning chorus keeps its visual identity.
  _planSections(context: PlanContext): Intent[] {
    const { sections, palette, barSec, available } = context;
    const intents: Intent[] = [];
    const patternByIdentity = new Map<number, string>();
    const { finalReturns } = context;
    const firstDivision = new Map<string, number>();
    let lastKey = '';

    for (const section of sections) {
      const timeMs = context.snapToDownbeatMs(section.start);
      const pattern = this._patternFor(section, patternByIdentity, context);
      const colours = coloursFor(section.identity, palette);
      const beatDivision = this._divisionFor(section, context,
        finalReturns.has(section) ? { from: firstDivision.get(passageOf(section)) || 1 } : null);
      if (!firstDivision.has(passageOf(section))) firstDivision.set(passageOf(section), beatDivision);

      // Clear strobeSpeed outside the strobe pattern so peaks do not leak into later scenes.
      const strobeSpeed = pattern === 'strobe'
        ? look.strobeSpeedFor(section.character, context.score, section.drive) : 0;
      const strobeFunction = section.resting ? 'standard'
        : look.strobeFunctionFor(section.character, context.score);

      const key = `${pattern}|${colours.join('|')}|${strobeSpeed}|${strobeFunction}|${beatDivision}|${splitFor(section, pattern, context)}`;
      if (key === lastKey) continue;
      lastKey = key;

      const fadeMs = timeMs < 500 ? 0 : context.fadeMs(SECTION_FADE_BARS[section.role] ?? 0.5);
      const split = splitFor(section, pattern, context);
      intents.push(scene(timeMs, {
        pattern, colors: colours, beatDivision, strobeSpeed, strobeFunction,
        role: section.role, label: section.label, level: section.level,
        identity: section.identity, ...(fadeMs > 0 ? { fadeMs } : {}),
        ...(split != null ? { split } : {}),
      }, { source: `section:${section.role}` }));

      intents.push(...this._rotateWithin(section, {
        pattern, colours, beatDivision, strobeFunction, timeMs,
      }, context));

      if (pattern === 'solid' && barSec) {
        // Four real bars on, so the change lands on a bar line.
        const followUpMs = context.barsAfterMs(timeMs, 4);
        if (followUpMs != null && followUpMs + 500 < section.end * 1000) {
          const followUp = restingPattern(restingLooks(RESTING_LOOKS), available, context.trackSeed + section.identity);
          if (followUp) {
            intents.push(scene(followUpMs, {
              pattern: followUp, colors: colours, beatDivision,
              strobeSpeed: 0, strobeFunction, fadeMs: context.fadeMs(1),
            }, { source: 'section:solid-followup', priority: PRIORITY.ROTATION }));
          }
        }
      }
    }
    return intents;
  }

  _patternFor(section: PlannedSection, patternByIdentity: Map<number, string>, context: PlanContext): string {
    const { available, mood, score, trackSeed } = context;

    // Apply role preferences before the identity cache so a fading chorus can become a restrained outro.
    const avoid = new Set<string>();
    for (const s of context.sections) {
      const last = s.identity === section.identity ? context.previousLooks[s.role] : undefined;
      if (last) avoid.add(last);
    }
    const lastOwn = context.previousLooks[section.role];
    const resting = firstOther(new Set(lastOwn ? [lastOwn] : []), (k) => restingPattern(restingLooks(section.profile.prefer), available, trackSeed + section.identity + k));
    if (resting) return resting;

    const known = patternByIdentity.get(section.identity);
    if (known !== undefined) return known;
    const pattern = look.pickPattern({
      character: section.character, available, score,
      seed: section.identity + trackSeed, drive: section.drive,
      dance: unit(mood.danceability, 0.5), pixels: context.pixels, pictures: context.pictures, avoid,
    });
    patternByIdentity.set(section.identity, pattern);
    return pattern;
  }

  // Use measured pulse strength to choose subdivisions; arousal alone does not establish a beat.
  _divisionFor(section: PlannedSection, context: PlanContext, arc: { from: number } | null = null): number {
    const { meter, score, isCalm } = context;
    if (isCalm || meter === 3 || context.factor < 0.5) return 1;
    if (section.resting) return 1;

    const pulse = unit(section.character.pulse, 0.4);
    const stability = unit(score.stability, 0.8);
    if (stability < 0.55 || pulse < 0.42) return 1;

    let division = 1;
    if (section.drive >= 0.55 && pulse >= 0.5) division = 2;
    if (section.drive >= 0.72 && pulse >= 0.62 && section.weight >= 0.62) division = 4;
    // Boost the final chorus from the faster prior reading so the largest return cannot look smaller.
    if (arc && pulse >= 0.5) division = Math.min(4, Math.max(division, arc.from) * 2);
    return Math.min(division, section.profile.maxDivision);
  }

  // Seed rotations by identity so repeated sections develop in the same order.
  _rotateWithin(section: PlannedSection, current: {
    pattern: string;
    colours: number[];
    beatDivision: number;
    strobeFunction: string;
    timeMs: number;
  }, context: PlanContext): Intent[] {
    const { barSec, isCalm, available, mood, score, drops, buildups } = context;
    if (isCalm || !barSec || current.pattern === 'solid' || section.resting) return [];

    let rotateBars = section.drive >= 0.8 ? 2 : section.drive >= 0.6 ? 4 : 8;
    if (context.factor > 0) rotateBars = Math.max(2, Math.round(rotateBars / context.factor));

    // Restrict rotation strides to phrase lengths so changes stay on musical boundaries.
    rotateBars = Math.min(16, Math.max(2, 2 ** Math.round(Math.log2(rotateBars))));

    // Count phrases from the section boundary so pickups cannot shift every later change.
    const endMs = Math.round(section.end * 1000);
    const at = (k: number) => context.barsAfterMs(current.timeMs, k * rotateBars);
    // Require two full rotation cycles so one isolated swap does not read as a glitch.
    const secondCycle = at(2);
    if (secondCycle == null || secondCycle > endMs) return [];

    const alternates: string[] = [];
    const seen = new Set([current.pattern]);
    for (let step = 1; step < 24 && alternates.length < 3; step++) {
      const candidate = look.pickPattern({
        character: section.character, available, score,
        seed: section.identity * 7 + step * 13 + context.trackSeed, drive: section.drive,
        dance: unit(mood.danceability, 0.5), pixels: context.pixels, pictures: context.pictures,
      });
      if (!seen.has(candidate)) {
        alternates.push(candidate);
        seen.add(candidate);
      }
    }
    if (!alternates.length) return [];
    // Return to the original look every fourth turn to mark the larger phrase.
    const cycle = [alternates[0], alternates[1] ?? current.pattern, alternates[2] ?? alternates[0], current.pattern];

    const intents: Intent[] = [];
    const rotationFade = CUT_ROLES.has(section.role) ? 0 : context.fadeMs(0.25);
    let i = 0;
    for (let k = 1, when = at(1); when != null && when + 1000 < endMs; k++, when = at(k)) {
      const inDrop = drops.some((d) => Math.abs(d.t * 1000 - when) < 2000);
      const inBuildup = buildups.some((b) => when >= b.t * 1000 - 200
        && when <= endOf(b) * 1000 + 200);
      if (!inDrop && !inBuildup) {
        const pattern = cycle[i % cycle.length];
        const split = splitFor(section, pattern, context);
        intents.push(scene(when, {
          pattern,
          colors: current.colours,
          beatDivision: current.beatDivision,
          strobeSpeed: 0,
          strobeFunction: current.strobeFunction,
          ...(rotationFade > 0 ? { fadeMs: rotationFade } : {}),
          ...(split != null ? { split } : {}),
        }, { source: 'rotation', priority: PRIORITY.ROTATION }));
      }
      i++;
    }
    return intents;
  }

  _planExpression(context: PlanContext): Intent[] {
    const { score, duration, silences, breaks, buildups, vocals } = context;
    if (!(duration > 0)) return [];

    const intents: Intent[] = [];
    const factor = Math.max(0, Math.min(2, context.factor));
    const intimate = unit((score.semantic || {}).intimate);
    const bassDecay = unit(score.decay, 0.25);

    for (let t = 0; t < duration; t += EXPRESSION_STEP_SEC) {
      const r = score.sample(t);
      const section = context.sectionAt(t);
      const resting = section ? section.resting : false;
      const quiet = !!spanAt(breaks, t);
      const build = spanAt(buildups, t);
      const progress = build
        ? unit((t - build.t) / Math.max(0.1, endOf(build) - build.t)) : 0;

      // Map the track’s dynamic range into the rig instead of imposing one fixed brightness range.
      let level = (0.3 + Math.pow(r.energy, 1 + r.range * 0.6) * 0.75 + r.impact * 0.15)
        * (0.5 + factor * 0.5);
      if (resting || quiet) level *= 0.65;
      if (build) level *= 0.65 + progress * 0.3;
      if (spanAt(silences, t)) level = 0;

      intents.push(expression(t * 1000, {
        level: unit(level),
        bass: unit(0.7 * r.bassline + 0.3 * r.kick),
        vocal: unit(Math.max(r.vocal, spanAt(vocals, t) ? 0.7 : 0)),
        air: unit(0.6 * r.texture + 0.25 * r.synth + 0.15 * r.snare),
        width: unit(score.width),
        motion: unit((0.2 + r.pulse * 0.45 + r.synth * 0.2 + progress * 0.35)
          * factor * (1 - intimate * 0.4)),
        decay: bassDecay,
      }));
    }

    // Emit silence boundaries explicitly so short silences cannot fall between samples.
    for (const event of silences) {
      intents.push(expression(event.t * 1000, { level: 0 },
        { source: 'silence', priority: PRIORITY.SILENCE_HARD }));
      const end = endOf(event);
      if (end < duration) {
        intents.push(expression(end * 1000, {
          level: spanAt(silences, end) ? 0
            : unit((0.2 + score.sample(end).energy * 0.65) * (0.45 + factor * 0.55)),
        }, { source: 'silence:end', priority: PRIORITY.SILENCE_HARD }));
      }
    }

    // End in darkness rather than leaving the last look latched.
    intents.push(expression(duration * 1000, { level: 0 },
      { source: 'end', priority: PRIORITY.SILENCE_HARD }));

    return intents;
  }

  _planBuildups(context: PlanContext): Intent[] {
    const { buildups, palette, meter, isCalm, factor, available, analysis, baseBpm } = context;
    if (isCalm || factor < 0.4) return [];

    const stability = finite(analysis.tempoStability, 1);
    const intents: Intent[] = [];

    for (const [buildupIndex, event] of buildups.entries()) {
      const startMs = Math.round(event.t * 1000);
      const endSec = endOf(event);
      const endMs = Math.round(endSec * 1000);
      const durationMs = Math.max(1000, endMs - startMs);
      const short = durationMs < 2000;

      const measured = measureBuildup({ start: event.t, end: endSec }, analysis, baseBpm);
      const triple = meter === 3;
      const riseDivision = triple ? 1 : (measured && measured.riseDivision) || 2;
      const peakDivision = triple ? 1 : (measured && measured.peakDivision) || 4;

      if (!short) {
        const tensionPattern = restingPattern(restingLooks(RESTING_LOOKS), available, context.trackSeed + buildupIndex) || 'fade';
        intents.push(scene(startMs, {
          pattern: tensionPattern,
          colors: [palette[0], palette[0], palette[0], palette[0]],  // deliberate narrowing
          strobeSpeed: 0, strobeFunction: 'standard', beatDivision: 1,
        }, { source: 'buildup:tension', priority: PRIORITY.BUILDUP }));
      }

      const riseAt = short ? startMs : startMs + Math.round(durationMs * 0.35);
      const risePattern = ['chase', 'split', 'runner', 'stack-up']
        .find((p) => available.has(p)) || 'chase';
      const riseSecond = palette.length >= 2 ? palette[1] : palette[0];
      intents.push(scene(riseAt, {
        pattern: risePattern,
        colors: [palette[0], riseSecond, palette[0], riseSecond],
        strobeSpeed: u8(60 * Math.min(1.5, factor)),
        strobeFunction: 'ramp-up',
        beatDivision: riseDivision,
      }, { source: 'buildup:rise', priority: PRIORITY.BUILDUP }));

      const peakAt = startMs + Math.round(durationMs * (short ? 0.5 : 0.75));
      intents.push(scene(peakAt, {
        pattern: 'strobe',
        strobeSpeed: u8(220 * Math.min(1.5, factor)),
        strobeFunction: 'break',
        beatDivision: peakDivision,
      }, { source: 'buildup:peak', priority: PRIORITY.BUILDUP }));

      // Let the track-wide drift pass own unstable tempos so build-ups do not fight a second clock.
      if (measured && measured.tempo && stability >= DRIFT_THRESHOLD) {
        let emitted = baseBpm;
        for (const point of measured.tempo.points) {
          if (point.tMs >= endMs) break;
          if (Math.abs(point.bpm - emitted) < 2) continue;
          intents.push(tempo(point.tMs, point.bpm, { source: 'buildup:ramp' }));
          emitted = point.bpm;
        }
        if (Math.abs(measured.tempo.settleBpm - emitted) >= 2) {
          intents.push(tempo(endMs, measured.tempo.settleBpm, { source: 'buildup:settle' }));
        }
      }

      intents.push(dark(Math.max(startMs, endMs - 150), {
        source: 'buildup:gap', priority: PRIORITY.BUILDUP,
        colorIndex: this.blackoutIndex,
      }));
    }
    return intents;
  }

  _planDrops(context: PlanContext): Intent[] {
    const { drops, palette, meter, isCalm, isLight, factor, score, available } = context;
    if (isCalm) return [];

    const intents: Intent[] = [];

    drops.forEach((event, index) => {
      const timeMs = Math.round(event.t * 1000);
      const data = event.data || {};
      const kind = data.kind || 'hype';
      if (factor < 0.6 && kind !== 'proper') return;
      if (isLight && kind !== 'proper') return;
      // Measured silence outranks an inferred drop so the largest gesture cannot fire into silence.
      if (spanAt(context.silences, event.t) || spanAt(context.breaks, event.t)) return;

      const confidence = unit((event.confidence || 0.5)
        + (data.snapTo === 'downbeat' ? 0.1 : 0));
      const section = context.sectionAt(event.t);
      const character = section ? section.character : score.sample(event.t);
      const drive = unit(context.effective * (0.7 + unit(character.energy) * 0.45));

      const colours = dropColours(index, palette);
      intents.push(scene(timeMs, {
        pattern: 'solid', colors: colours, strobeSpeed: 0,
        strobeFunction: 'standard', beatDivision: meter === 3 ? 1 : 4,
      }, { source: 'drop:anchor', priority: PRIORITY.DROP }));

      // Use white strobe when the set’s contrast budget cannot afford a blinder.
      const ration = (b: ReturnType<typeof look.burstFor>) => (b === BURST.BLINDER && context.arc?.blinder === false ? BURST.WHITE_STROBE : b);

      if (kind !== 'proper') {
        const burst = ration(look.burstFor({ moment: 'drop', character, score, drive: drive * 0.8 }));
        const burstMs = Math.round((400 + confidence * 300) * Math.min(1.5, factor));
        intents.push(accent(timeMs + 1, burst, Math.max(MIN_BURST_MS, burstMs), {
          source: 'drop:hype', priority: PRIORITY.DROP, confidence,
        }));
        const pool = ['hit', 'sections', 'pairs', 'chase'].filter((p) => available.has(p));
        if (pool.length) {
          intents.push(scene(timeMs + 1, {
            pattern: pool[index % pool.length], colors: colours,
            beatDivision: meter === 3 ? 1 : 2,
          }, { source: 'drop:hype-pattern', priority: PRIORITY.DROP }));
        }
        return;
      }

      const breakdown = unit(finite(data.breakdown ?? data.breakdownScore, 0.5), 0.5);
      const sustain = unit(finite(data.sustain ?? data.sustainScore, 0.5), 0.5);
      const variant = (breakdown >= 0.6 && confidence >= 0.6) ? 'slam'
        : sustain >= 0.6 ? 'color-burst' : 'punch';

      const movePool = (drive >= 0.75
        ? ['hit', 'runner', 'pairs', 'chase', 'split', 'sections', 'random-flash', 'stack-up']
        : ['pairs', 'chase', 'split', 'runner', 'stack-up']).filter((p) => available.has(p));
      const movePattern = movePool.length ? movePool[index % movePool.length] : 'chase';
      const moveDivision = meter === 3 ? 1 : (drive >= 0.75 ? 4 : 2);

      if (variant === 'slam') {
        const burst = ration(look.burstFor({ moment: 'drop', character, score, drive }));
        // Reserve full-rig blinders for arrivals with enough confidence and headroom.
        const useBlinder = burst === BURST.BLINDER && confidence >= 0.55 && factor >= 0.6;
        const blinderMs = useBlinder
          ? Math.round((300 + confidence * 250) * Math.min(1.5, factor)) : 0;
        if (useBlinder) {
          intents.push(accent(timeMs, BURST.BLINDER, blinderMs,
            { source: 'drop:slam', priority: PRIORITY.DROP, confidence }));
          intents.push(color(timeMs + blinderMs + 9, colours,
            { source: 'drop:slam', priority: PRIORITY.DROP }));
        }
        const afterMs = timeMs + blinderMs + (useBlinder ? 10 : 1);
        const strobeMs = Math.round((500 + confidence * 300) * Math.min(1.5, factor));
        intents.push(accent(afterMs,
          useBlinder ? BURST.WHITE_STROBE : burst,
          Math.max(MIN_BURST_MS, strobeMs),
          { source: 'drop:slam', priority: PRIORITY.DROP, confidence }));
        intents.push(scene(afterMs + strobeMs + 20, {
          pattern: movePattern, colors: colours, strobeSpeed: 0,
          strobeFunction: 'ramp-down', beatDivision: moveDivision,
        }, { source: 'drop:slam', priority: PRIORITY.DROP }));

      } else if (variant === 'color-burst') {
        const burst = ration(look.burstFor({ moment: 'drop', character, score, drive: drive * 0.9 }));
        const strobeMs = Math.round((600 + confidence * 400) * Math.min(1.5, factor));
        intents.push(accent(timeMs + 1, burst, Math.max(MIN_BURST_MS, strobeMs),
          { source: 'drop:color-burst', priority: PRIORITY.DROP, confidence }));
        intents.push(scene(timeMs + strobeMs + 20, {
          pattern: movePattern, colors: colours, strobeSpeed: 0,
          strobeFunction: 'standard', beatDivision: moveDivision,
        }, { source: 'drop:color-burst', priority: PRIORITY.DROP }));

      } else {
        const pool = ['hit', 'sections', 'split', 'chase', 'random-flash', 'stack-up']
          .filter((p) => available.has(p));
        intents.push(scene(timeMs + 100, {
          pattern: pool.length ? pool[index % pool.length] : 'chase',
          colors: colours, strobeSpeed: 0, strobeFunction: 'standard',
          beatDivision: meter === 3 ? 1 : 4,
        }, { source: 'drop:punch', priority: PRIORITY.DROP }));
      }
    });

    return intents;
  }

  _planQuiet(context: PlanContext): Intent[] {
    const { silences, breaks, palette, available, isCalm, continuous } = context;
    const intents: Intent[] = [];

    if (!continuous) {
      for (const event of silences) {
        intents.push(dark(Math.round(event.t * 1000), {
          source: 'silence', priority: PRIORITY.SILENCE, colorIndex: this.blackoutIndex,
        }));
      }
    }

    if (!isCalm) {
      for (const [breakIndex, event] of breaks.entries()) {
        const pattern = restingPattern(restingLooks([...RESTING_LOOKS, 'solid']), available, context.trackSeed + breakIndex);
        if (!pattern) continue;
        intents.push(scene(Math.round(event.t * 1000), {
          pattern,
          colors: [palette[0], palette[palette.length - 1], palette[0],
            palette[palette.length - 1]],
          beatDivision: 1, strobeSpeed: 0, strobeFunction: 'ramp-down',
        }, { source: 'break', priority: PRIORITY.SECTION }));
      }
    }
    return intents;
  }

  _planColourMoves(context: PlanContext): Intent[] {
    const { melodies, bassHits, bars, palette, score, drops, buildups, isCalm } = context;
    const intents: Intent[] = [];
    const inDrop = (ms: number) => drops.some((d) => {
      const delta = ms - d.t * 1000;
      return delta >= -1500 && delta <= 2500;
    });
    const inBuildup = (ms: number) => buildups.some((b) => ms >= b.t * 1000 && ms <= endOf(b) * 1000);

    // Rotate every palette slot together so moves preserve the dominant, contrast, accent and lift roles.
    let step = 0;
    const emit = (t: number, source: string) => {
      const section = context.sectionAt(t);
      const h = hueCount(palette);
      const base = look.goldenStep(section ? section.identity : 0, h);
      const turn = h > 1 ? base + 1 + (step % (h - 1)) : base;
      intents.push(color(t * 1000, slotsFor(palette, turn), { source, fadeMs: context.fadeMs(0.25) }));
      step++;
    };

    if (melodies.length) {
      let lastMs = -Infinity;
      for (const event of melodies) {
        const ms = Math.round(event.t * 1000);
        if (ms - lastMs < 3500 || inDrop(ms) || inBuildup(ms)) continue;
        emit(event.t, 'melody');
        lastMs = ms;
      }
      return intents;
    }

    // Quantise timbre changes to bar lines so the movement remains musical.
    let lastTimbre = -Infinity;
    for (const event of bars) {
      if (event.t - lastTimbre < 5 || inDrop(event.t * 1000) || inBuildup(event.t * 1000)) continue;
      if (score.novelty(event.t) < 0.12) continue;
      const section = context.sectionAt(event.t);
      if (!section || event.t - section.start < 4 || section.end - event.t < 2) continue;
      emit(event.t, 'timbre');
      lastTimbre = event.t;
    }
    if (lastTimbre > -Infinity) return intents;

    if (context.effective >= 0.85) return intents;
    const gapMs = isCalm ? 4500 : 1400;
    let lastMs = -Infinity;
    for (const event of bassHits) {
      const ms = Math.round(event.t * 1000);
      if (ms - lastMs < gapMs || inDrop(ms) || inBuildup(ms)) continue;
      const section = context.sectionAt(event.t);
      if (!section || section.weight < 0.36 || section.weight > 0.68) continue;
      emit(event.t, 'bass-hit');
      lastMs = ms;
    }
    return intents;
  }

  _planAccents(context: PlanContext): AccentIntent[] {
    const { bars, beats, spikes, bassHits, score, isCalm, analysis } = context;
    if (isCalm) return [];

    const dance = unit((context.mood || {}).danceability, 0.5);
    const candidates: AccentIntent[] = [];
    const propose = (t: number, confidence: number, source: string, priority: number, intensity = 0.5) => {
      const section = context.sectionAt(t);
      if (!section || !section.profile.accents || section.resting) return;
      if (section.drive < 0.28) return;
      const character = score.sample(t);
      const vocal = character.vocal > 0.55
        || context.vocals.some((v) => t >= v.t && t <= endOf(v));
      const burst = look.burstFor({
        moment: 'accent', character, score, drive: section.drive, vocal,
        // Compressed masters need darkness for contrast because bright accents have no headroom.
        headroom: score.crest >= 0.35,
      });
      // Match accent duration to measured band decay so percussive hits do not smear across the groove.
      const durationMs = burst === BURST.KILL || burst === BURST.GLOW
        ? Math.round(110 + (1 - unit(score.articulation, 0.5)) * 190)
        : MIN_BURST_MS;
      candidates.push(accent(t * 1000, burst, Math.max(120, durationMs), {
        source, priority, confidence: unit(confidence, 0.5), intensity: unit(intensity, 0.5),
      }));
    };

    const confidentBars = bars.length > 0
      && (analysis.downbeatConfidence == null || analysis.downbeatConfidence >= 0.10);
    if (confidentBars) {
      let index = 0;
      for (const bar of bars) {
        const section = context.sectionAt(bar.t);
        index++;
        if (!section) continue;
        let every = strideFor(section.drive, context.factor * (context.arc?.budget ?? 1), dance);
        if (every && context.finalReturns.has(section)) every = Math.max(1, Math.round(every / 2));
        if (!every || index % every !== 0) continue;
        const confidence = bar.confidence == null ? 0.5 : bar.confidence;
        if (context.drums && drumsPlay(context.drums, section, context.barSec)) {
          const hit = nearestHit(context.drums.marks, bar.t, HIT_SNAP_SEC);
          if (!hit) continue;
          propose(hit.t, Math.max(confidence, hit.s * 0.9), 'bar', PRIORITY.BAR_ACCENT, hit.s);
          continue;
        }
        propose(bar.t, confidence, 'bar', PRIORITY.BAR_ACCENT);
      }
    } else {
      let lastT = -Infinity;
      for (let i = 0; i < beats.length; i++) {
        if (i + 1 < beats.length && (beats[i + 1].t - beats[i].t) < 0.4) i++;
        const beat = beats[i];
        if (!beat || beat.intensity < 0.6) continue;
        const section = context.sectionAt(beat.t);
        if (!section) continue;
        const every = strideFor(section.drive, context.factor * (context.arc?.budget ?? 1), dance);
        if (!every) continue;
        // Normalise to four beats so density does not depend on the grid source.
        const minGap = every * 4 * (60 / Math.max(20, context.baseBpm));
        if (beat.t - lastT < minGap) continue;
        propose(beat.t, beat.confidence, 'beat', PRIORITY.BEAT_ACCENT, beat.intensity);
        lastT = beat.t;
      }
    }

    for (const event of spikes) {
      const hit = context.drums ? nearestHit(context.drums.marks, event.t, HIT_SNAP_SEC) : null;
      propose(hit ? hit.t : event.t, event.confidence, 'spike', PRIORITY.BAR_ACCENT, event.intensity);
    }
    if (context.drums && context.barSec) {
      for (const section of context.sections.slice(1)) {
        const fill = context.drums.fillHits.filter((h) => h.t >= section.start - context.barSec!
          && h.t < section.start - 0.05);
        if (fill.length < FILL_HITS) continue;
        const last = fill[fill.length - 1];
        const strength = fill.reduce((sum, h) => sum + h.s, 0) / fill.length;
        propose(last.t, strength, 'fill', PRIORITY.FILL_ACCENT, Math.min(1, strength + 0.2));
      }
    }
    for (const event of bassHits) {
      if (event.confidence < 0.7) continue;
      propose(event.t, event.confidence * 0.8, 'instrument', PRIORITY.BEAT_ACCENT, event.intensity);
    }

    return candidates;
  }

  _applyContrast(accents: readonly AccentIntent[], context: PlanContext,
    booked: readonly AccentIntent[] = []): AccentIntent[] {
    const { drops, vocals, silences, breaks, tier, factor, effective, score, barSec } = context;
    const base = ACCENT_BUDGET[tier] != null ? ACCENT_BUDGET[tier] : ACCENT_BUDGET.unknown;
    // Scale within the tier’s ceiling so relative drive changes density without exceeding its budget.
    const budgetPerMinute = Math.round(base
      * Math.min(2, Math.max(0, factor))
      * (0.55 + unit(effective) * 0.45)
      * (context.arc?.budget ?? 1));

    const dropTimes = drops.map((d) => d.t * 1000);
    const guardMs = 1000 * (barSec
      ? Math.min(DROP_GUARD_SEC.max, Math.max(DROP_GUARD_SEC.min, DROP_GUARD_BARS * barSec))
      : DROP_GUARD_SEC.fallback);
    const kept: AccentIntent[] = [];
    const trust = 0.6 + 0.4 * unit(score.confidence, 0.8);

    // Use measured intensity to rank accents while preserving the shared per-minute cap.
    const climax = (x: AccentIntent) => {
      const section = context.sectionAt?.(x.timeMs / 1000);
      return section && context.finalReturns?.has(section) ? 4 / 3 : 1;
    };
    const strength = (x: AccentIntent) => (x.confidence || 0) * (0.5 + unit(x.intensity, 0.5)) * climax(x);
    const ranked = accents.slice().sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (strength(b) - strength(a)) || a.timeMs - b.timeMs;
    });

    for (const intent of ranked) {
      if (intent.priority >= PRIORITY.DROP) { kept.push(intent); continue; }
      if (intent.confidence * trust < 0.3) continue;

      const t = intent.timeMs;
      if (dropTimes.some((d) => t >= d - guardMs * (1 + BAR_JITTER) && t < d)) continue;
      if (dropTimes.some((d) => t >= d && t < d + guardMs * (1 - BAR_JITTER))) continue;
      if (spanAt(silences, t / 1000) || spanAt(breaks, t / 1000)) continue;

      // Restrict vocal passages to sparse soft accents so the lighting does not strobe over a sung phrase.
      const inVocal = vocals.some((v) => t >= v.t * 1000 && t <= endOf(v) * 1000);
      if (inVocal) {
        if (intent.burst !== BURST.GLOW && intent.burst !== BURST.KILL) continue;
        if (kept.some((k) => Math.abs(k.timeMs - t) < 8000)) continue;
      }

      if (overlaps(kept, intent) || overlaps(booked, intent)) continue;
      if (budgetPerMinute <= 0) continue;
      if (exceedsBudget(kept, intent, budgetPerMinute)) continue;

      kept.push(intent);
    }

    return kept.sort((a, b) => a.timeMs - b.timeMs);
  }

  // Keep the last tempo intent at each timestamp so the most specific planning pass wins.
  _dedupeTempo(intents: Intent[]): Intent[] {
    const seen = new Map<number, number>();
    intents.forEach((intent, index) => {
      if (intent.kind !== INTENT.TEMPO) return;
      seen.set(intent.timeMs, index);
    });
    return intents.filter((intent, index) => intent.kind !== INTENT.TEMPO
      || seen.get(intent.timeMs) === index);
  }
}

function normalise(analysis: Analysis | null | undefined): DirectorAnalysis {
  const a: Analysis = analysis || {};
  return {
    ...a,
    mood: a.mood || a.perception?.mood || {},
    genre: a.genre || a.perception?.genre || null,
    bpm: a.bpm ?? a.rhythm?.bpm ?? a.track?.bpm,
    duration: a.duration ?? a.track?.duration,
    segments: a.segments || a.structure?.sections,
    key: a.key || a.perception?.key || a.track?.key,
    scale: a.scale || a.perception?.scale || a.track?.mode,
  };
}

interface Hit { t: number; s: number }

export interface DrumHits {
  marks: Hit[];
  fillHits: Hit[];
  played: number[];
}

function drumHitsOf(analysis: DirectorAnalysis): DrumHits | null {
  const pulse = analysis.pulse;
  if (!pulse || !pulse.lanes || !(finite(pulse.detector, 0) >= DRUM_DETECTOR)) return null;
  const hitsOf = (name: string): Hit[] => {
    const lane = pulse.lanes[name];
    if (!lane || !Array.isArray(lane.t)) return [];
    return lane.t.map((t, i) => ({ t: finite(t), s: unit(lane.s?.[i]) }));
  };
  const stems = pulse.source === 'stems';
  const kicks = hitsOf('kick');
  const snares = stems ? hitsOf('snare') : [];
  const marks = [...kicks, ...snares].filter((h) => h.s >= STRONG_HIT).sort((a, b) => a.t - b.t);
  const played = [...kicks, ...snares, ...hitsOf('hats')].map((h) => h.t).sort((a, b) => a - b);
  if (!marks.length) return null;
  return { marks, fillHits: snares.filter((h) => h.s >= 0.5), played };
}

function nearestHit(hits: readonly Hit[], t: number, window: number): Hit | null {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best: Hit | null = null;
  for (const h of [hits[lo - 1], hits[lo]]) {
    if (h && Math.abs(h.t - t) <= window && (!best || Math.abs(h.t - t) < Math.abs(best.t - t))) best = h;
  }
  return best;
}

function drumsPlay(drums: DrumHits, section: { start: number; end: number }, barSec: number | null): boolean {
  const bars = Math.max(1, (section.end - section.start) / (barSec || 2));
  let n = 0;
  for (const t of drums.played) if (t >= section.start && t < section.end) n++;
  return n >= bars;
}

function endOf(event: ShowEvent): number {
  const end = event && event.data ? event.data.end : undefined;
  if (typeof end === 'number' && Number.isFinite(end)) return end;
  return finite(event && event.t) + finite(event && event.duration);
}

function spanAt(events: readonly ShowEvent[], t: number): ShowEvent | undefined {
  return events.find((e) => t >= e.t && t < endOf(e));
}

// Split resting sections at confident measured drops so structural labels cannot hide a real arrival.
function splitRestingAtDrops(raw: readonly Segment[], drops: readonly Drop[]): readonly Segment[] {
  if (!raw.length || !drops.length) return raw;
  const segments = raw.slice();

  const MIN_HEAD_SEC = 4;
  const MIN_TAIL_SEC = 8;

  const qualifies = (d: Drop, from: number, to: number) => d && finite(d.confidence, 0) >= 0.6
    && d.kind !== 'hype' && d.t >= from && d.t <= to;

  const out: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const section = segments[i];
    const start = finite(section.start);
    const end = Math.max(start, finite(section.end));
    if (!RESTING_ROLES.has(section.role || 'unknown')) { out.push(section); continue; }

    const next = segments[i + 1];
    const late = next && !RESTING_ROLES.has(next.role || 'unknown')
      && drops.find((d) => qualifies(d, Math.max(start + MIN_HEAD_SEC, end - MIN_TAIL_SEC), end));
    if (late) {
      out.push({ ...section, end: late.t });
      segments[i + 1] = { ...next, start: late.t };
      continue;
    }

    const at = drops.find((d) => qualifies(d, start + MIN_HEAD_SEC, end - MIN_TAIL_SEC));
    if (!at) { out.push(section); continue; }

    out.push({ ...section, end: at.t });
    out.push({
      ...section,
      start: at.t,
      // Drop the inherited cluster label so the identity pass can recognise a newly split passage.
      role: 'drop',
      label: null,
      level: section.level === 'low' ? 'mid' : section.level,
    });
  }
  return out;
}

const RESTING_LOOKS = ['ribbon', 'fade', 'wave'];

const PIXEL_RESTING_LOOKS = ['gradient', 'plasma'];

function restingLooks(prefer: string[] | null): string[] | null {
  return prefer ? [...prefer, ...PIXEL_RESTING_LOOKS] : prefer;
}

const PIXEL_MAPS = ['stage', 'mirror', 'bar'];

const MIRRORED_ROLES = new Set(['chorus', 'drop']);
const MIRRORED_LOOKS = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong', 'stack-up',
  'sections', 'split', 'random-flash', 'wave', 'comet', 'gradient']);

const PIXEL_ROLE_LOOKS: Record<string, readonly { pattern: string; map: string }[]> = {
  intro:        [{ pattern: 'gradient', map: 'stage' }],
  verse:        [{ pattern: 'gradient', map: 'stage' }],
  prechorus:    [{ pattern: 'rise', map: 'mirror' }, { pattern: 'comet', map: 'mirror' }],
  chorus:       [{ pattern: 'comet', map: 'mirror' }],
  drop:         [{ pattern: 'impact', map: 'stage' }, { pattern: 'burst', map: 'stage' }],
  breakdown:    [{ pattern: 'plasma', map: 'stage' }, { pattern: 'gradient', map: 'stage' }],
  bridge:       [{ pattern: 'drums', map: 'bar' }, { pattern: 'comet', map: 'bar' }],
  instrumental: [{ pattern: 'drums', map: 'mirror' }, { pattern: 'burst', map: 'stage' }],
  outro:        [{ pattern: 'plasma', map: 'stage' }, { pattern: 'gradient', map: 'stage' }],
};

const PANEL_ROLE_LOOKS: Record<string, readonly string[]> = {
  intro:        ['rain', 'bars'],
  verse:        ['bars', 'rain'],
  prechorus:    ['bars', 'fire'],
  buildup:      ['bars', 'fire'],
  chorus:       ['fire', 'bars'],
  drop:         ['fire', 'bars'],
  breakdown:    ['rain', 'bars'],
  bridge:       ['bars', 'fire'],
  instrumental: ['bars', 'fire'],
  outro:        ['rain', 'bars'],
};
const PANEL_LOOKS = ['bars', 'fire', 'rain'];

const DROP_STROBES = ['impact', 'flash-fill', 'flash-scatter', 'core'];
const DRIVING_STROBES = ['flash-alternate', 'flash-chase', 'ramp', 'core'];
const STROBE_DRIVE = 0.72;
const STROBE_ROLES = new Set(['chorus', 'instrumental', 'bridge']);

const STROBE_MAPS: Record<string, string> = {
  impact: 'stage', 'flash-scatter': 'stage', 'flash-chase': 'mirror',
  'flash-fill': 'bar', 'flash-alternate': 'bar', ramp: 'bar', core: 'bar',
};

const CELL_LOOKS = new Set(['gradient', 'comet', 'burst', 'plasma', 'drums', 'stems', 'rise', 'impact', 'ensemble', 'ribbon', 'wave', 'rainbow',
  'twinkle', 'sparkle', 'bars', 'fire', 'rain',
  'flash-chase', 'flash-scatter', 'flash-fill', 'flash-alternate', 'ramp', 'core']);

const PAR_WASHES: readonly (readonly string[])[] = [
  ['ensemble', 'wave', 'fade'],
  ['ensemble', 'split', 'color-cycle', 'wave'],
  ['hit', 'sections', 'color-cycle', 'split'],
];

function firstOther<T>(avoid: ReadonlySet<T>, pick: (k: number) => T): T {
  const first = pick(0);
  if (!avoid.size || !avoid.has(first)) return first;
  for (let k = 1; k < 8; k++) {
    const next = pick(k);
    if (!avoid.has(next)) return next;
  }
  return first;
}

function barLook(looks: readonly string[], available: ReadonlySet<string>): string | null {
  return looks.find((p) => available.has(p)) ?? null;
}

function strobeLook(looks: readonly string[], seed: number, available: ReadonlySet<string>): string | null {
  const pool = looks.filter((p) => available.has(p));
  return pool.length ? pool[Math.abs(Math.round(seed)) % pool.length] : null;
}

function parWash(drive: number, seed: number, available: ReadonlySet<string>): string | null {
  const pool = PAR_WASHES[drive >= 0.72 ? 2 : drive >= 0.45 ? 1 : 0].filter((p) => available.has(p));
  return pool.length ? pool[Math.abs(Math.round(seed)) % pool.length] : null;
}

function beatsBetween(context: { beats: readonly ShowEvent[]; baseBpm: number }, from: number, to: number): number {
  const counted = context.beats.filter((b) => b.t >= from && b.t < to).length;
  return counted >= 2 ? counted : Math.round(((to - from) * context.baseBpm) / 60);
}

function restingPattern(prefer: string[] | null, available: ReadonlySet<string>, seed: number): string | null {
  if (!prefer) return null;
  const moving = prefer.filter((p) => p !== 'solid' && available.has(p));
  if (moving.length) return moving[Math.abs(Math.round(seed)) % moving.length];
  return prefer.find((p) => available.has(p)) || null;
}

function trackSeedOf(analysis: DirectorAnalysis | null | undefined): number {
  const t: object = (analysis && analysis.track) || {};
  const text = `${field(t, 'artist') || ''}|${field(t, 'name') || ''}|${Math.round(finite(analysis && analysis.duration, 0))}`;
  let h = 0x811c9dc5;  // FNV-1a
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 9973;
}

function medianGap(downbeats: readonly number[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < downbeats.length; i++) {
    const gap = downbeats[i] - downbeats[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

function splitFor(section: PlannedSection, pattern: string, context: { trackSeed: number }): number | null {
  if (section.resting || section.drive < SPLIT_DRIVE || !SPLITTABLE.has(pattern)) return null;
  return Math.abs(section.identity + context.trackSeed) % 1000;
}

const passageOf = (section: PlannedSection): string => `${section.identity}|${section.role}`;

function lastReturns(sections: readonly PlannedSection[]): Set<PlannedSection> {
  const last = new Map<string, PlannedSection>();
  const count = new Map<string, number>();
  for (const section of sections) {
    if (section.resting || section.identity == null) continue;
    const key = passageOf(section);
    count.set(key, (count.get(key) || 0) + 1);
    last.set(key, section);
  }
  return new Set([...last].filter(([key]) => (count.get(key) || 0) > 1).map(([, s]) => s));
}

function barWalker(downbeats: readonly number[], barSec: number | null): (fromMs: number, bars: number) => number | null {
  return (fromMs, bars) => {
    const t = fromMs / 1000;
    if (downbeats.length) {
      let lo = 0;
      let hi = downbeats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (downbeats[mid] < t) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(downbeats[lo - 1] - t) <= Math.abs(downbeats[lo] - t)) lo--;
      const target = lo + bars;
      if (target < downbeats.length) return Math.round(downbeats[target] * 1000);
      if (barSec) {
        const last = downbeats.length - 1;
        return Math.round((downbeats[last] + (target - last) * barSec) * 1000);
      }
    }
    return barSec ? Math.round(fromMs + bars * barSec * 1000) : null;
  };
}

function hueCount(palette: readonly number[]): number {
  return palette.length === 4 ? 3 : palette.length;
}

function slotsFor(palette: readonly number[], turn: number): number[] {
  const n = palette.length;
  if (!n) return [0, 0, 0, 0];
  const h = hueCount(palette);
  const at = (i: number) => palette[(((turn + i) % h) + h) % h];
  if (n === 4) return [at(0), at(1), at(2), palette[3]];
  if (n === 3) return [at(0), at(1), at(2), at(0)];
  if (n === 2) return [at(0), at(1), at(0), at(1)];
  return [at(0), at(0), at(0), at(0)];
}

function coloursFor(identity: number, palette: readonly number[]): number[] {
  return slotsFor(palette, look.goldenStep(identity, hueCount(palette)));
}

function dropColours(index: number, palette: readonly number[]): number[] {
  return slotsFor(palette, look.goldenStep(index, hueCount(palette)));
}

function strideFor(drive: number, factor: number, dance: number): number {
  if (drive < 0.3) return 0;
  const push = drive * 0.75 + dance * 0.25;
  const bars = Math.round(2 ** (4.2 - push * 3.2));   // 18 bars at 0, 2 at 1
  const scaled = factor > 0 ? bars / factor : bars * 4;
  return Math.max(1, Math.min(64, Math.round(scaled)));
}

function overlaps(kept: readonly AccentIntent[], intent: AccentIntent): boolean {
  const SAFETY_MS = 60;
  return kept.some((k) => intent.timeMs < k.timeMs + k.durationMs + SAFETY_MS
    && k.timeMs < intent.timeMs + intent.durationMs + SAFETY_MS);
}

function exceedsBudget(kept: readonly AccentIntent[], intent: AccentIntent, budgetPerMinute: number): boolean {
  const MINUTE = 60000;
  const times = kept.filter((k) => k.priority < PRIORITY.DROP).map((k) => k.timeMs);
  times.push(intent.timeMs);
  times.sort((a, b) => a - b);
  for (const start of times) {
    if (start > intent.timeMs || start + MINUTE <= intent.timeMs) continue;
    const count = times.filter((t) => t >= start && t < start + MINUTE).length;
    if (count > budgetPerMinute) return true;
  }
  return false;
}

function measureBuildup(build: { start: number; end: number }, analysis: Analysis,
  baseBpm: number): BuildupMeasure | null {
  const startSec = build.start;
  const endSec = build.end;
  const span = endSec - startSec;
  if (!(span > 0.5)) return null;

  const out: BuildupMeasure = { rollRatio: null, riseDivision: null, peakDivision: null, tempo: null };

  const declared = list(analysis.buildups).find((b) => b
    && Math.abs(finite(b.start) - startSec) < 0.5);
  if (declared && declared.subdivision !== undefined && Number.isFinite(declared.subdivision) && declared.subdivision >= 2) {
    out.peakDivision = Math.min(8, Math.max(2, Math.round(declared.subdivision)));
    out.riseDivision = Math.max(2, out.peakDivision / 2);
  }

  const onsets = list(analysis.onsets);
  if (!out.peakDivision && onsets.length) {
    const third = span / 3;
    const countIn = (from: number, to: number) => {
      let n = 0;
      for (const t of onsets) {
        if (t >= from && t < to) n++;
        else if (t >= to) break;      // onsets are sorted
      }
      return n;
    };
    const early = countIn(startSec, startSec + third) / third;
    const late = countIn(endSec - third, endSec) / third;
    if (early >= 0.5) {
      const ratio = late / early;
      out.rollRatio = Math.round(ratio * 100) / 100;
      out.peakDivision = ratio >= 3 ? 8 : ratio >= 1.4 ? 4 : 2;
      out.riseDivision = Math.max(2, out.peakDivision / 2);
    }
  }

  const curve = list(analysis.tempoCurve);
  const inWindow = curve.filter((p) => p && p.t >= startSec && p.t <= endSec);
  if (inWindow.length >= 3) {
    const from = inWindow[0].v;
    const to = inWindow[inWindow.length - 1].v;
    const delta = to - from;
    let agree = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const step = inWindow[i].v - inWindow[i - 1].v;
      if (step !== 0 && Math.sign(step) === Math.sign(delta)) agree++;
    }
    const monotone = agree / (inWindow.length - 1);

    if (Math.abs(delta) >= TEMPO_RAMP_MIN_BPM && monotone >= 0.7) {
      const after = curve.filter((p) => p && p.t > endSec && p.t <= endSec + 6);
      const settle = after.length
        ? after.reduce((sum, p) => sum + p.v, 0) / after.length
        : baseBpm;
      out.tempo = {
        points: inWindow.map((p) => ({ tMs: Math.round(p.t * 1000), bpm: clampBpm(p.v) })),
        settleBpm: clampBpm(settle),
        fromBpm: clampBpm(from),
        toBpm: clampBpm(to),
      };
    }
  }

  return (out.peakDivision || out.tempo) ? out : null;
}

export {
  ShowDirector,
  measureBuildup,
  normalise,
  strideFor,
  coloursFor,
  ROLE_PROFILE,
  ACCENT_BUDGET,
  RESTING_ROLES,
  TEMPO_RAMP_MIN_BPM,
  DRIFT_THRESHOLD,
  MIN_BURST_MS,
  EXPRESSION_STEP_SEC,
  IDENTITY_SIMILARITY,
  clampBpm,
  u8,
};
