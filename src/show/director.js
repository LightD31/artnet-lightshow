'use strict';

/**
 * The show director.
 *
 * This is the layer that decides what a show *does* — not what any individual
 * moment sounds like, which the analyser already answered, but how the evening
 * is paced. It reads musical events and emits lighting intents.
 *
 * The rules it works to are the ones a human operator works to:
 *
 *   Contrast is the product. A show that flashes constantly has no big moments
 *   because everything is a big moment. So the director keeps an explicit
 *   budget — a cap on accents per minute, a minimum gap, a recovery window
 *   after every drop — and spends it. When the budget is tight, the lowest
 *   priority accents are the ones that go.
 *
 *   Rest is a decision, not an absence. Breakdowns, intros and outros get a
 *   deliberately restrained look with no accents at all. That is what makes the
 *   chorus after them land.
 *
 *   Anticipation beats reaction. Nothing fires in the bars immediately before a
 *   drop except the build-up's own arc, because a stray accent there spends the
 *   audience's attention a second before the moment that needed it.
 *
 *   Repeats look like repeats. Sections that the analyser clustered together
 *   get the same pattern and the same palette rotation every time they return,
 *   so the second chorus reads as the chorus and not as a new idea.
 *
 * Everything the director emits is an intent; `render.js` turns intents into
 * the patches the Art-Net engine applies. The two are kept apart so this file
 * can be read as a set of decisions rather than as a stream of channel values.
 */

const { EVENT, deriveEvents, byType } = require('./musical-events');
const look = require('./look');
const {
  INTENT, BURST, PRIORITY, scene, color, accent, tempo, dark,
} = require('./intents');

// Matches the patch schema's bpm bounds, and only those. This is the guard that
// stops an out-of-range value throwing inside a timer callback and taking the
// server down mid-set; it is deliberately not a judgement about which tempos
// are musically plausible, because build-ups are allowed to be extreme.
const clampBpm = (n) => Math.max(20, Math.min(300, Math.round(n) || 120));
const u8 = (n) => Math.max(0, Math.min(255, Math.round(n) || 0));

// How far the tempo has to move across a build-up before it counts as a ramp
// rather than as the tempogram wobbling. The curve is already clamped to ±15 %
// of the global BPM and median-filtered, so what is left is small; 3 BPM is
// where a drift stops being deniable and starts being audible.
const TEMPO_RAMP_MIN_BPM = 3;

// Below this stability the analyser is confident the tempo genuinely drifts,
// and the beat clock has to follow the curve across the whole track.
const DRIFT_THRESHOLD = 0.60;

/**
 * How each section role is treated. This table *is* the show's sense of
 * arrangement: it is what makes an intro restrained and a chorus generous
 * without either decision being buried in a threshold somewhere.
 *
 *   levelBias   shifts the section's energy tier up or down before anything
 *               else reads it
 *   accents     may this role carry bar accents at all
 *   maxDivision ceiling on how far the beat clock subdivides here
 *   prefer      patterns to reach for first, when the rig has them
 */
const ROLE_PROFILE = {
  intro:     { levelBias: -1, accents: false, maxDivision: 1, prefer: ['fade', 'wave', 'solid'] },
  verse:     { levelBias: 0,  accents: true,  maxDivision: 2, prefer: null },
  chorus:    { levelBias: 1,  accents: true,  maxDivision: 4, prefer: null },
  drop:      { levelBias: 1,  accents: true,  maxDivision: 4, prefer: null },
  bridge:    { levelBias: 0,  accents: true,  maxDivision: 2, prefer: null },
  breakdown: { levelBias: -1, accents: false, maxDivision: 1, prefer: ['fade', 'wave'] },
  outro:     { levelBias: -1, accents: false, maxDivision: 1, prefer: ['fade', 'wave', 'solid'] },
  unknown:   { levelBias: 0,  accents: true,  maxDivision: 4, prefer: null },
};

// Accents allowed per minute, before the intensity fader scales it. These are
// deliberately low: drops and build-ups carry the big moments, and bar accents
// are garnish. The previous engine ran roughly three times this and the bursts
// stopped reading as anything at all.
const ACCENT_BUDGET = { dance: 12, moderate: 7, rock: 4, calm: 0, unknown: 6 };

// Seconds of quiet the director keeps after a drop, and before one.
const RECOVERY_SEC = 3.0;
const ANTICIPATION_SEC = 2.0;

// Minimum burst length. At 40 Hz DMX, 300 ms is about twelve frames plus two or
// three pulses of the fixture's own strobe channel — below that an LED par has
// not finished responding before it is told to stop.
const MIN_BURST_MS = 300;


class ShowDirector {
  /**
   * @param {object} options
   * @param {Array}  options.patterns      pattern descriptors the rig supports
   * @param {Array}  options.colorPresets  the colour table, for palette bounds
   * @param {number} options.paletteSize   2 | 3 | 4
   * @param {number} options.intensity     0..100 operator fader
   * @param {number} options.blackoutIndex colour index that means "off"
   */
  constructor({ patterns = [], colorPresets = null, paletteSize = 4,
    intensity = 50, blackoutIndex = 0 } = {}) {
    this.patterns = patterns;
    this.colorPresets = colorPresets;
    this.paletteSize = paletteSize;
    this.intensity = intensity;
    this.blackoutIndex = blackoutIndex;
  }

  /**
   * Plan a whole track.
   *
   * Returns `{ intents, palette, paletteName, context }`. The intents are time
   * sorted and have already been through the contrast pass, so what comes out
   * is what the show will actually do.
   */
  plan(analysis) {
    const context = this._context(analysis);
    const intents = [];

    intents.push(...this._openingIntent(context));
    intents.push(...this._planTempo(context));
    intents.push(...this._planSections(context));
    intents.push(...this._planBuildups(context));
    intents.push(...this._planDrops(context));
    intents.push(...this._planQuiet(context));
    intents.push(...this._planColourMoves(context));

    const accents = this._planAccents(context);
    const kept = this._applyContrast(accents, context);

    const all = intents.concat(kept);
    all.sort((a, b) => a.timeMs - b.timeMs || b.priority - a.priority);
    return {
      intents: this._dedupeTempo(all),
      palette: context.palette,
      paletteName: context.paletteName,
      context,
    };
  }

  // ── Context ─────────────────────────────────────────────────────────────

  /**
   * Everything the planning passes need, derived once.
   *
   * Two judgement calls live here and nowhere else, so they cannot drift apart
   * between passes: the show tier (how hard the rig is allowed to work) and the
   * effective level of each section.
   */
  _context(analysis) {
    const events = deriveEvents(analysis);
    const grouped = byType(events);
    const mood = analysis.mood || {};
    const genreStyle = look.styleFor(analysis.genre);
    const tier = look.tierFor(analysis, mood);
    const { palette, name: paletteName } = look.buildPalette({
      key: analysis.key, scale: analysis.scale, mood, genreStyle,
      paletteSize: this.paletteSize, colorPresets: this.colorPresets,
    });

    const meter = analysis.meter || 4;
    const downbeats = Array.isArray(analysis.downbeats) ? analysis.downbeats : [];
    const barSec = downbeats.length >= 2 ? (downbeats[1] - downbeats[0]) : null;
    const baseBpm = clampBpm(analysis.bpm);
    const factor = this.intensity / 50;  // 0 … 2, with 50 as "normal"

    const arousal = mood.arousal || 0;
    const isCalm = this.intensity === 0
      || ((tier === 'calm' || (tier === 'unknown' && arousal < 0.55)) && factor < 1.4);
    const isLight = !isCalm && (factor < 0.6
      || ((tier === 'rock' || (tier === 'moderate' && arousal < 0.65)) && factor < 1.6));

    const sections = this._sections(analysis, { tier, mood, isCalm });

    return {
      analysis, events, grouped, mood, genreStyle, tier, factor, isCalm, isLight,
      palette, paletteName, meter, downbeats, barSec, baseBpm, sections,
      available: new Set(this.patterns.map((p) => p.id)),
      drops: grouped.get(EVENT.DROP) || [],
      buildups: grouped.get(EVENT.BUILDUP) || [],
      bars: grouped.get(EVENT.BAR) || [],
      beats: grouped.get(EVENT.BEAT) || [],
      vocals: grouped.get(EVENT.VOCAL_SECTION) || [],
      silences: grouped.get(EVENT.SILENCE) || [],
      breaks: grouped.get(EVENT.BREAK) || [],
      melodies: grouped.get(EVENT.MELODY_CHANGE) || [],
      // White strobe is reserved for the loudest slams. Reaching for it on
      // every bright accent is what made it stop meaning anything.
      allowWhiteStrobe: tier === 'dance' && (arousal >= 0.70 || factor >= 1.6),
      snapToDownbeatMs: this._snapper(downbeats, barSec),
    };
  }

  /**
   * Sections with an effective level attached.
   *
   * Two corrections are applied, and both exist because the analyser's levels
   * are percentiles *within one track*:
   *
   *   A minimalist arrangement — sparse 808s, no dynamic range — reads as `low`
   *   in every section even when the track is genuinely energetic. When every
   *   section shares one level and the mood disagrees, promote.
   *
   *   The mirror case: on a calm track a relatively loud passage reads `high`
   *   without being loud in any absolute sense, and must not launch a banger.
   */
  _sections(analysis, { mood, isCalm }) {
    const raw = Array.isArray(analysis.segments) ? analysis.segments : [];
    const levels = new Set(raw.map((s) => s.level));
    const flat = levels.size === 1 && raw.length > 0;
    const only = flat ? [...levels][0] : null;
    const arousalHigh = (mood.arousal || 0) > 0.75;
    const kickHigh = (mood.kickiness || 0) > 0.7;

    let promote = 0;
    if (flat && only === 'low' && arousalHigh && kickHigh) promote = 2;
    else if (flat && only === 'low' && arousalHigh) promote = 1;
    else if (flat && only === 'mid' && arousalHigh && kickHigh) promote = 1;

    const shift = (level, steps) => {
      const order = ['low', 'mid', 'high'];
      const index = Math.max(0, order.indexOf(level));
      return order[Math.max(0, Math.min(2, index + steps))];
    };

    return raw.map((section, index) => {
      const role = section.role || 'unknown';
      const profile = ROLE_PROFILE[role] || ROLE_PROFILE.unknown;
      let level = promote ? shift(section.level, promote) : section.level;
      level = shift(level, profile.levelBias);
      if (isCalm && level === 'high') level = 'mid';
      return {
        ...section,
        index,
        role,
        profile,
        level,
        rawLevel: section.level,
        start: Number(section.start) || 0,
        end: Number(section.end) || 0,
      };
    });
  }

  /**
   * Snap a time to the nearest downbeat within half a bar.
   *
   * Section boundaries come from a beat-synchronous clustering and are already
   * close to a bar line; nudging them onto one is the difference between a
   * scene change that feels intended and one that feels like a glitch. Beyond
   * half a bar the boundary is left alone — that is a different bar, and moving
   * it there would be a bigger lie than the one being fixed.
   */
  _snapper(downbeats, barSec) {
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

  // ── Passes ──────────────────────────────────────────────────────────────

  /** Put the rig into a known state before anything else happens. */
  _openingIntent(context) {
    return [scene(0, {
      bpm: context.baseBpm,
      beatDivision: 1,
      running: true,
      masterBlackout: false,
      strobeSpeed: 0,
      strobeFunction: 'standard',
      opening: true,
    }, { source: 'opening', priority: PRIORITY.SECTION })];
  }

  /**
   * Follow a genuinely drifting tempo across the whole track.
   *
   * Only for tracks the analyser is confident about: with the octave-anchored
   * tempo curve, stability below 0.60 means the tempo really does move. Stable
   * tracks skip this entirely rather than jittering the beat clock.
   */
  _planTempo(context) {
    const { analysis } = context;
    const stability = analysis.tempoStability != null ? analysis.tempoStability : 1;
    const curve = Array.isArray(analysis.tempoCurve) ? analysis.tempoCurve : [];
    if (stability >= DRIFT_THRESHOLD || curve.length <= 2) return [];

    const intents = [];
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

  /**
   * A look per section, plus rotation inside long ones.
   *
   * Patterns and palette offsets are keyed on the section's cluster label so a
   * returning chorus returns to the same look. Where the analyser gave no
   * label, the palette walks by golden step instead — sequential offsets slide
   * one slot per section, which on a four-colour palette makes a verse and a
   * chorus look nearly identical.
   */
  _planSections(context) {
    const { sections, palette, meter, barSec, isCalm, tier, factor, available } = context;
    const intents = [];
    const patternByLabel = new Map();
    const offsetByLabel = new Map();
    let lastKey = '';

    sections.forEach((section, index) => {
      const timeMs = context.snapToDownbeatMs(section.start);
      const pattern = this._patternFor(section, index, patternByLabel, context);
      const colours = this._coloursFor(section, index, offsetByLabel, palette);
      const beatDivision = this._divisionFor(section, context);

      // strobeSpeed is only honoured when the pattern *is* the strobe, so it is
      // zeroed otherwise — a leftover speed from a build-up peak would
      // otherwise bleed into the next section.
      const strobeSpeed = pattern === 'strobe' ? look.sectionStrobeSpeed(section) : 0;
      const strobeFunction = look.sectionStrobeFunction(section);

      const key = `${pattern}|${colours.join('|')}|${strobeSpeed}|${strobeFunction}|${beatDivision}`;
      if (key === lastKey) return;
      lastKey = key;

      intents.push(scene(timeMs, {
        pattern, colors: colours, beatDivision, strobeSpeed, strobeFunction,
        role: section.role, label: section.label, level: section.level,
      }, { source: `section:${section.role}` }));

      intents.push(...this._rotateWithin(section, {
        pattern, colours, beatDivision, strobeFunction, timeMs, index,
      }, context));

      // `solid` is a static look. Four bars of it is a held moment; thirty
      // seconds of it is the show having stalled.
      if (pattern === 'solid' && barSec) {
        const followUpMs = timeMs + Math.round(barSec * 4 * 1000);
        if (followUpMs + 500 < section.end * 1000) {
          const followUp = ['fade', 'wave'].find((p) => available.has(p));
          if (followUp) {
            intents.push(scene(followUpMs, {
              pattern: followUp, colors: colours, beatDivision,
              strobeSpeed: 0, strobeFunction,
            }, { source: 'section:solid-followup', priority: PRIORITY.ROTATION }));
          }
        }
      }
    });

    void isCalm; void tier; void factor; void meter;
    return intents;
  }

  _patternFor(section, index, patternByLabel, context) {
    const key = section.label ? `${section.label}` : null;
    if (key && patternByLabel.has(key)) return patternByLabel.get(key);

    const { available, mood, genreStyle } = context;
    // A role with a preference gets it when the rig has it: an intro that opens
    // on a chase is an intro that has given away the chorus.
    const preferred = section.profile.prefer
      && section.profile.prefer.find((p) => available.has(p));
    const pattern = preferred || look.pickPattern({
      section, seed: index, available, mood, genreStyle,
    });
    if (key) patternByLabel.set(key, pattern);
    return pattern;
  }

  _coloursFor(section, index, offsetByLabel, palette) {
    let base;
    if (section.label) {
      if (!offsetByLabel.has(section.label)) offsetByLabel.set(section.label, offsetByLabel.size);
      base = offsetByLabel.get(section.label) * 2;
    } else {
      base = look.goldenStep(index, palette.length);
    }
    const at = (offset) => palette[(base + offset) % palette.length];
    return [
      at(0),
      palette.length >= 2 ? at(1) : at(0),
      palette.length >= 3 ? at(2) : at(0),
      palette.length >= 4 ? at(3) : at(1),
    ];
  }

  /**
   * How far the beat clock subdivides in this section.
   *
   * This is the main lever for intensity that is not a strobe: the same pattern
   * at four times the beat rate reads as far more aggressive without a single
   * extra flash. Triple metre stays on quarters — subdividing 3/4 by two puts
   * the rig on the off-beats of the bar.
   */
  _divisionFor(section, context) {
    const { meter, tier, factor, isCalm, mood } = context;
    if (isCalm || meter === 3 || factor < 0.5) return 1;

    const arousal = mood.arousal || 0;
    const energy = section.energy || 0;
    const brightness = section.brightness || 0;
    let division = 1;

    if (section.level === 'high') {
      if ((tier === 'dance' || factor >= 1.4)
          && (energy > 0.7 || arousal > 0.85 || factor >= 1.6)) division = 4;
      else if (brightness > 0.35 || arousal > 0.75 || tier === 'dance' || factor >= 1.2) division = 2;
    } else if (section.level === 'mid'
        && ((arousal > 0.75 && tier === 'dance') || factor >= 1.4)) {
      division = 2;
    }
    return Math.min(division, section.profile.maxDivision);
  }

  /**
   * Rotate through two alternate patterns inside a long section.
   *
   * A section locked to one look for thirty seconds relies entirely on accents
   * for variation, which is exactly the budget the show is trying to save.
   * Repeated sections rotate identically — the rotation is seeded from the
   * cluster label — so verse one and verse two stay in step visually.
   */
  _rotateWithin(section, current, context) {
    const { barSec, isCalm, tier, factor, available, mood, genreStyle, drops, buildups } = context;
    if (isCalm || !barSec || current.pattern === 'solid') return [];

    let rotateBars = 0;
    if (section.level === 'high' && tier === 'dance') rotateBars = 4;
    else if (section.level === 'high') rotateBars = 8;
    else if (section.level === 'mid' && tier === 'dance') rotateBars = 8;
    else if (section.level === 'mid' && tier === 'moderate') rotateBars = 16;
    if (!rotateBars) return [];
    if (factor > 0) rotateBars = Math.max(2, Math.round(rotateBars / factor));

    const endMs = Math.round(section.end * 1000);
    const stepMs = Math.round(rotateBars * barSec * 1000);
    // A single mid-section swap reads as a glitch rather than as development;
    // only rotate when there is room for at least two full cycles.
    if (endMs - current.timeMs < stepMs * 2) return [];

    // Walk seeds with a coprime stride until two *distinct* alternates turn up.
    // Fixed offsets collide whenever both land on the same slot of a short pool.
    const seed = section.label
      ? section.label.charCodeAt(0) * 7 + section.label.length
      : current.index;
    const alternates = [];
    const seen = new Set([current.pattern]);
    for (let step = 1; step < 24 && alternates.length < 2; step++) {
      const candidate = look.pickPattern({
        section, seed: seed + step * 13, available, mood, genreStyle,
      });
      if (!seen.has(candidate)) {
        alternates.push(candidate);
        seen.add(candidate);
      }
    }
    if (!alternates.length) return [];

    const intents = [];
    let i = 0;
    for (let at = current.timeMs + stepMs; at + 1000 < endMs; at += stepMs) {
      const inDrop = drops.some((d) => Math.abs(d.t * 1000 - at) < 2000);
      const inBuildup = buildups.some((b) => at >= b.t * 1000 - 200
        && at <= (b.data.end != null ? b.data.end : b.t + b.duration) * 1000 + 200);
      if (!inDrop && !inBuildup) {
        intents.push(scene(at, {
          pattern: alternates[i % alternates.length],
          colors: current.colours,
          beatDivision: current.beatDivision,
          strobeSpeed: 0,
          strobeFunction: current.strobeFunction,
        }, { source: 'rotation', priority: PRIORITY.ROTATION }));
      }
      i++;
    }
    return intents;
  }

  /**
   * The tension arc before a drop.
   *
   * The professional instinct here is counter-intuitive: a build-up should
   * *contrast* with the drop it leads to, not preview it. If the drop is bright
   * and busy, the build-up narrows — one colour, no movement — and the restraint
   * is what makes the payoff land. Phases, proportional to the window:
   *
   *   tension  0–35 %    simplify, single colour, quarters
   *   rise     35–75 %   escalate pattern and colour, strobe channel opens
   *   peak     75–92 %   stuttering strobe at the measured subdivision
   *   gap      last 150 ms — dark, so the drop has something to arrive from
   *
   * The two beat divisions are a fallback. `measureBuildup` reads what the
   * music actually does — how far the roll subdivides, and whether the tempo
   * genuinely moves — and those numbers win whenever there are any.
   */
  _planBuildups(context) {
    const { buildups, palette, meter, isCalm, factor, available, analysis, baseBpm } = context;
    if (isCalm || factor < 0.4) return [];

    const stability = analysis.tempoStability != null ? analysis.tempoStability : 1;
    const intents = [];

    for (const event of buildups) {
      const startMs = Math.round(event.t * 1000);
      const endSec = event.data.end != null ? event.data.end : event.t + event.duration;
      const endMs = Math.round(endSec * 1000);
      const durationMs = Math.max(1000, endMs - startMs);
      const short = durationMs < 2000;

      const measured = measureBuildup(
        { start: event.t, end: endSec }, analysis, baseBpm);
      const triple = meter === 3;
      const riseDivision = triple ? 1 : (measured && measured.riseDivision) || 2;
      const peakDivision = triple ? 1 : (measured && measured.peakDivision) || 4;

      if (!short) {
        const tensionPattern = ['fade', 'wave'].find((p) => available.has(p)) || 'fade';
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

      // Follow a real tempo change through the build-up — but only when the
      // track is otherwise steady. On a genuinely drifting one the drift pass
      // is already emitting across the whole track, and two sources of truth
      // for the beat clock would fight.
      if (measured && measured.tempo && stability >= DRIFT_THRESHOLD) {
        let emitted = baseBpm;
        for (const point of measured.tempo.points) {
          // Strictly inside the window: the drop instant belongs to the settle
          // below, and two BPM patches on one millisecond resolve by whichever
          // way the sort happened to fall.
          if (point.tMs >= endMs) break;
          if (Math.abs(point.bpm - emitted) < 2) continue;
          intents.push(tempo(point.tMs, point.bpm, { source: 'buildup:ramp' }));
          emitted = point.bpm;
        }
        // Put the clock where the track actually sits after the drop. A push
        // that resolves has to be undone or every pattern past the drop runs
        // fast; a real tempo change has to be kept for the same reason.
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

  /**
   * Drops. Three variants rotate so consecutive drops feel distinct:
   *
   *   slam         blinder, then strobe, then explosive movement — the biggest
   *   color-burst  no blinder; the palette colour carries the impact
   *   punch        no burst at all; pattern and beat division do the work
   *
   * A solid anchor at the exact instant is always emitted first so every
   * fixture snaps to the same hot colour before anything else happens.
   */
  _planDrops(context) {
    const { drops, palette, meter, isCalm, isLight, factor, tier, available,
      allowWhiteStrobe } = context;
    if (isCalm) return [];

    const VARIANTS = ['slam', 'color-burst', 'punch'];
    const intents = [];

    drops.forEach((event, index) => {
      const timeMs = Math.round(event.t * 1000);
      const kind = event.data.kind || 'hype';
      if (factor < 0.6 && kind !== 'proper') return;
      if (isLight && kind !== 'proper') return;

      const confidence = Math.max(0, Math.min(1,
        (event.confidence || 0.5) + (event.data.snapTo === 'downbeat' ? 0.1 : 0)));

      const length = palette.length;
      const slot = length ? look.goldenStep(index, length) : 0;
      const opposite = Math.max(1, Math.floor(length / 2));
      const colours = [
        palette[slot] || 0,
        length >= 2 ? palette[(slot + opposite) % length] : palette[slot] || 0,
        length >= 3 ? palette[(slot + 2) % length] : palette[slot] || 0,
        length >= 4 ? palette[(slot + 3) % length] : palette[slot] || 0,
      ];

      intents.push(scene(timeMs, {
        pattern: 'solid', colors: colours, strobeSpeed: 0,
        strobeFunction: 'standard', beatDivision: meter === 3 ? 1 : 4,
      }, { source: 'drop:anchor', priority: PRIORITY.DROP }));

      if (kind !== 'proper') {
        const burstMs = Math.round((400 + confidence * 300) * Math.min(1.5, factor));
        intents.push(accent(timeMs + 1, BURST.COLOR_STROBE, Math.max(MIN_BURST_MS, burstMs), {
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

      const variant = (confidence >= 0.75 && index === 0)
        ? 'slam' : VARIANTS[index % VARIANTS.length];
      const movePool = (tier === 'dance'
        ? ['hit', 'runner', 'pairs', 'chase', 'split', 'sections', 'random-flash', 'stack-up']
        : ['pairs', 'chase', 'split', 'runner', 'stack-up']).filter((p) => available.has(p));
      const movePattern = movePool.length ? movePool[index % movePool.length] : 'chase';
      const moveDivision = meter === 3 ? 1 : (tier === 'dance' ? 4 : 2);

      if (variant === 'slam') {
        const useBlinder = (tier === 'dance' || factor >= 1.6)
          && confidence >= 0.55 && factor >= 0.6;
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
        const white = allowWhiteStrobe && confidence >= 0.65
          && (event.data.breakdown == null || event.data.breakdown >= 0.6);
        intents.push(accent(afterMs, white ? BURST.WHITE_STROBE : BURST.COLOR_STROBE,
          Math.max(MIN_BURST_MS, strobeMs),
          { source: 'drop:slam', priority: PRIORITY.DROP, confidence }));
        intents.push(scene(afterMs + strobeMs + 20, {
          pattern: movePattern, colors: colours, strobeSpeed: 0,
          strobeFunction: 'ramp-down', beatDivision: moveDivision,
        }, { source: 'drop:slam', priority: PRIORITY.DROP }));

      } else if (variant === 'color-burst') {
        const strobeMs = Math.round((600 + confidence * 400) * Math.min(1.5, factor));
        intents.push(accent(timeMs + 1, BURST.COLOR_STROBE, Math.max(MIN_BURST_MS, strobeMs),
          { source: 'drop:color-burst', priority: PRIORITY.DROP, confidence }));
        intents.push(scene(timeMs + strobeMs + 20, {
          pattern: movePattern, colors: colours, strobeSpeed: 0,
          strobeFunction: 'standard', beatDivision: moveDivision,
        }, { source: 'drop:color-burst', priority: PRIORITY.DROP }));

      } else {
        // Punch: the anchor reads for ~100 ms, then straight to movement. All
        // the impact comes from pattern and beat division, which is what makes
        // it feel different from the two variants that flash.
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

  /**
   * Silences go dark, and breaks pull the show back.
   *
   * A break is where the contrast for the next chorus is manufactured, so the
   * director spends it deliberately: a slow envelope pattern, quarters, no
   * strobe. Doing nothing here would leave the previous section's look running
   * through the one moment the audience is meant to notice the difference.
   */
  _planQuiet(context) {
    const { silences, breaks, palette, available, isCalm } = context;
    const intents = [];

    for (const event of silences) {
      intents.push(dark(Math.round(event.t * 1000), {
        source: 'silence', priority: PRIORITY.SILENCE, colorIndex: this.blackoutIndex,
      }));
    }

    if (!isCalm) {
      for (const event of breaks) {
        const pattern = ['fade', 'wave', 'solid'].find((p) => available.has(p));
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

  /**
   * Colour moves that are not scene changes.
   *
   * Melody changes get first call — a chord change is the musical reason to
   * move colour, and following it makes the palette feel like it is listening.
   * Where the analyser found none (an older document, or an unpitched track)
   * the bass hits stand in, throttled hard.
   *
   * Dance tracks are deliberately excluded from the bass-hit path: they already
   * express groove through beat division, and colour flips on top read as
   * twitchy rather than as energetic.
   */
  _planColourMoves(context) {
    const { melodies, grouped, palette, sections, drops, buildups, tier, isCalm } = context;
    const intents = [];
    const inDrop = (ms) => drops.some((d) => {
      const delta = ms - d.t * 1000;
      return delta >= -1500 && delta <= 2500;
    });
    const inBuildup = (ms) => buildups.some((b) => {
      const end = b.data.end != null ? b.data.end : b.t + b.duration;
      return ms >= b.t * 1000 && ms <= end * 1000;
    });

    let step = 0;
    if (melodies.length) {
      let lastMs = -Infinity;
      for (const event of melodies) {
        const ms = Math.round(event.t * 1000);
        if (ms - lastMs < 6000) continue;
        if (inDrop(ms) || inBuildup(ms)) continue;
        intents.push(color(ms, [palette[look.goldenStep(step, palette.length)]],
          { source: 'melody' }));
        step++;
        lastMs = ms;
      }
      return intents;
    }

    if (tier === 'dance') return intents;
    const hits = grouped.get(EVENT.BASS_HIT) || [];
    const gapMs = isCalm ? 4500 : 2000;
    let lastMs = -Infinity;
    for (const event of hits) {
      const ms = Math.round(event.t * 1000);
      if (ms - lastMs < gapMs) continue;
      const section = sections.find((s) => event.t >= s.start && event.t < s.end);
      // Only mid sections: high ones already have movement and division doing
      // the work, and more on top just smears.
      if (!section || section.level !== 'mid') continue;
      if (inDrop(ms) || inBuildup(ms)) continue;
      intents.push(color(ms, [palette[look.goldenStep(step, palette.length)]],
        { source: 'bass-hit' }));
      step++;
      lastMs = ms;
    }
    return intents;
  }

  /**
   * Candidate bar accents, before the budget is applied.
   *
   * Prefers the downbeat grid so an accent always lands on beat one. Falls back
   * to strong beats only when there are no usable downbeats — and applies the
   * same throttling there, because the old fallback had none and fired on every
   * strong beat of every loud section.
   */
  _planAccents(context) {
    const { bars, beats, sections, isCalm, tier, factor, mood, analysis } = context;
    if (isCalm) return [];

    const throttleScale = factor > 0 ? 1 / factor : 4;
    const arousal = mood.arousal || 0;
    let highEvery;
    let midEligible;
    let midEvery;
    if (tier === 'dance') {
      highEvery = Math.max(1, Math.round(4 * throttleScale));
      midEligible = factor >= 0.3;
      midEvery = Math.max(2, Math.round(16 * throttleScale));
    } else if (tier === 'moderate') {
      highEvery = Math.max(1, Math.round(8 * throttleScale));
      midEligible = factor >= 0.5;
      midEvery = Math.max(4, Math.round(32 * throttleScale));
    } else if (tier === 'rock') {
      highEvery = Math.max(2, Math.round(16 * throttleScale));
      midEligible = factor >= 1.4;
      midEvery = Math.max(4, Math.round(32 * throttleScale));
    } else {
      highEvery = arousal >= 0.92 ? Math.max(1, Math.round(2 * throttleScale))
        : arousal >= 0.78 ? Math.max(1, Math.round(8 * throttleScale))
          : Math.max(2, Math.round(16 * throttleScale));
      midEligible = arousal >= 0.70 || factor >= 1.4;
      midEvery = arousal >= 0.92 ? Math.max(2, Math.round(8 * throttleScale))
        : arousal >= 0.78 ? Math.max(4, Math.round(16 * throttleScale))
          : Math.max(8, Math.round(32 * throttleScale));
    }

    const sectionAt = (t) => sections.find((s) => t >= s.start && t < s.end);
    const confident = bars.length > 0
      && (analysis.downbeatConfidence == null || analysis.downbeatConfidence >= 0.10);
    const intents = [];

    if (confident) {
      bars.forEach((bar, index) => {
        const section = sectionAt(bar.t);
        if (!section || !section.profile.accents) return;
        const every = section.level === 'high' ? highEvery
          : (section.level === 'mid' && midEligible) ? midEvery : 0;
        if (!every || index % every !== 0) return;
        intents.push(accent(bar.t * 1000, BURST.COLOR_STROBE, MIN_BURST_MS, {
          source: 'bar', priority: PRIORITY.BAR_ACCENT,
          confidence: bar.confidence == null ? 0.5 : bar.confidence,
        }));
      });
      return intents;
    }

    const minGapMs = Math.round((arousal >= 0.92 ? 2400
      : arousal >= 0.78 ? 9600 : 19200) * throttleScale);
    let lastMs = -Infinity;
    for (let i = 0; i < beats.length; i++) {
      // Sub-400 ms coalescing: below that the rig is past DMX and LED response
      // time, and firing on every beat just smears into a blur.
      if (i + 1 < beats.length && (beats[i + 1].t - beats[i].t) < 0.4) i++;
      const beat = beats[i];
      if (!beat || beat.intensity < 0.6) continue;
      const ms = Math.round(beat.t * 1000);
      if (ms - lastMs < minGapMs) continue;
      const section = sectionAt(beat.t);
      if (!section || !section.profile.accents) continue;
      const allowed = section.level === 'high' || (section.level === 'mid' && midEligible);
      if (!allowed) continue;
      intents.push(accent(ms, BURST.COLOR_STROBE, MIN_BURST_MS, {
        source: 'beat', priority: PRIORITY.BEAT_ACCENT, confidence: beat.confidence,
      }));
      lastMs = ms;
    }
    return intents;
  }

  /**
   * The contrast pass — the difference between a show and a strobe machine.
   *
   * Every accent the passes above proposed is a *request*. This is where the
   * show decides which ones it can afford, in one place, with the whole track
   * in view. Four rules, applied in time order:
   *
   *   anticipation  nothing in the couple of seconds before a drop. The
   *                 build-up's own arc owns that window, and an accent there
   *                 spends attention a moment before the payoff needed it.
   *   recovery      nothing for three seconds after a drop. The drop *is* the
   *                 statement; carrying on flashing over it reads as the rig
   *                 not having noticed.
   *   separation    a burst must finish, plus a safety gap, before the next one
   *                 starts — otherwise the first is clipped in half before the
   *                 fixtures have finished responding to it.
   *   budget        a hard cap on accents per rolling minute, from the show
   *                 tier and the intensity fader. Over budget, the lowest
   *                 confidence candidates go first.
   *
   * Drop accents are exempt: they are the moments the budget exists to protect.
   */
  _applyContrast(accents, context) {
    const { drops, vocals, tier, factor } = context;
    const budgetPerMinute = Math.round((ACCENT_BUDGET[tier] != null
      ? ACCENT_BUDGET[tier] : ACCENT_BUDGET.unknown) * Math.min(2, Math.max(0, factor)));

    const sorted = accents.slice().sort((a, b) => a.timeMs - b.timeMs);
    const dropTimes = drops.map((d) => d.t * 1000);
    const kept = [];
    const window = [];
    let freeAt = -Infinity;

    for (const intent of sorted) {
      if (intent.priority >= PRIORITY.DROP) {
        kept.push(intent);
        freeAt = intent.timeMs + intent.durationMs + 60;
        window.push(intent.timeMs);
        continue;
      }

      const beforeDrop = dropTimes.some((t) => intent.timeMs >= t - ANTICIPATION_SEC * 1000
        && intent.timeMs < t);
      const afterDrop = dropTimes.some((t) => intent.timeMs >= t
        && intent.timeMs <= t + RECOVERY_SEC * 1000);
      if (beforeDrop || afterDrop) continue;

      if (intent.timeMs < freeAt) continue;

      // A sung phrase wants atmosphere. Strobing over a vocal is the single
      // most common way an automatic show announces that it is automatic — so
      // only a genuinely energetic dance track is allowed to, and even then at
      // half the usual rate.
      const inVocal = vocals.some((v) => {
        const end = v.data.end != null ? v.data.end : v.t + v.duration;
        return intent.timeMs >= v.t * 1000 && intent.timeMs <= end * 1000;
      });
      if (inVocal && !(tier === 'dance' && factor >= 1.0)) continue;
      if (inVocal && kept.length && (intent.timeMs - kept[kept.length - 1].timeMs) < 8000) continue;

      while (window.length && window[0] < intent.timeMs - 60000) window.shift();
      if (budgetPerMinute <= 0 || window.length >= budgetPerMinute) continue;

      kept.push(intent);
      window.push(intent.timeMs);
      freeAt = intent.timeMs + intent.durationMs + 60;
    }
    return kept;
  }

  /**
   * One tempo instruction per millisecond, and never two.
   *
   * Two BPM intents on the same instant resolve by whichever way the sort
   * happened to fall — and if the wrong one wins, the rig runs the entire rest
   * of the track at a build-up's peak tempo. The later intent wins, because the
   * passes are ordered so the more specific one is emitted last.
   */
  _dedupeTempo(intents) {
    const seen = new Map();
    intents.forEach((intent, index) => {
      if (intent.kind !== INTENT.TEMPO) return;
      seen.set(intent.timeMs, index);
    });
    return intents.filter((intent, index) => intent.kind !== INTENT.TEMPO
      || seen.get(intent.timeMs) === index);
  }
}


/**
 * How a build-up actually accelerates, measured instead of assumed.
 *
 * Two independent things happen in the seconds before a drop and they need
 * separate answers:
 *
 *   The roll. Standard production practice is to double the *subdivision* at
 *   constant tempo — a snare on quarters, then eighths, then sixteenths,
 *   sometimes thirty-seconds. That is what an audience hears as "speeding up",
 *   and it never touches BPM. Onset density measures it directly: the onsets in
 *   the last third of the window against those in the first third.
 *
 *   The ramp. Some tracks genuinely change tempo into a drop, and the beat
 *   clock has to follow or the rig drifts out of time at the most exposed
 *   moment of the song. Rarer than the roll, and independent of it.
 *
 * Returns null when there is nothing measurable, so the caller keeps its own
 * default rather than acting on an invented number.
 */
function measureBuildup(build, analysis, baseBpm) {
  const startSec = build.start;
  const endSec = build.end;
  const span = endSec - startSec;
  if (!(span > 0.5)) return null;

  const out = { rollRatio: null, riseDivision: null, peakDivision: null, tempo: null };

  const onsets = Array.isArray(analysis.onsets) ? analysis.onsets : null;
  if (onsets && onsets.length) {
    const third = span / 3;
    const countIn = (from, to) => {
      let n = 0;
      for (const t of onsets) {
        if (t >= from && t < to) n++;
        else if (t >= to) break;      // onsets are sorted
      }
      return n;
    };
    const early = countIn(startSec, startSec + third) / third;
    const late = countIn(endSec - third, endSec) / third;
    // An early third with nothing in it is a build-up that starts from silence,
    // not one that accelerates; a ratio against zero says nothing.
    if (early >= 0.5) {
      const ratio = late / early;
      out.rollRatio = Math.round(ratio * 100) / 100;
      // One doubling → sixteenths, two → thirty-seconds. Below 1.4 there is no
      // roll worth the name and the rig should not pretend there is.
      //
      // 8 rather than the schema's 16 is a limit of the rig, not restraint:
      // renderDmx runs at 40 fps and the pattern steps every
      // (60000 / bpm) / division ms, so division 8 stays under the frame rate up
      // to 300 BPM while division 16 passes it above 150. Past that it loses
      // steps unevenly, which reads as irregular rather than as faster.
      out.peakDivision = ratio >= 3 ? 8 : ratio >= 1.4 ? 4 : 2;
      out.riseDivision = Math.max(2, out.peakDivision / 2);
    }
  }

  const curve = Array.isArray(analysis.tempoCurve) ? analysis.tempoCurve : [];
  const inWindow = curve.filter((p) => p && p.t >= startSec && p.t <= endSec);
  if (inWindow.length >= 3) {
    const from = inWindow[0].v;
    const to = inWindow[inWindow.length - 1].v;
    const delta = to - from;
    // Count the steps that agree with the overall direction. A curve that
    // wanders up and down by the same total is noise, not a ramp.
    let agree = 0;
    for (let i = 1; i < inWindow.length; i++) {
      const step = inWindow[i].v - inWindow[i - 1].v;
      if (step !== 0 && Math.sign(step) === Math.sign(delta)) agree++;
    }
    const monotone = agree / (inWindow.length - 1);

    // Nothing here rejects a ramp for being *large*. The drift pass next door
    // skips any sample outside 50–220 BPM as a likely octave error and is right
    // to: it runs across a whole drifting track, where a doubled reading is the
    // common failure. A build-up is the opposite case — the one place a track is
    // allowed to do something extreme on purpose — so the filters here are for
    // noise, not for size.
    if (Math.abs(delta) >= TEMPO_RAMP_MIN_BPM && monotone >= 0.7) {
      // Where the track sits *after* the drop decides whether the ramp resolves
      // or sticks: a riser that pushes and falls back has to be undone, and a
      // genuine tempo change has to be kept, for the same reason.
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

module.exports = {
  ShowDirector, measureBuildup, ROLE_PROFILE, ACCENT_BUDGET,
  TEMPO_RAMP_MIN_BPM, DRIFT_THRESHOLD, MIN_BURST_MS, clampBpm, u8,
};
