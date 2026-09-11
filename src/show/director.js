'use strict';

/**
 * The show director.
 *
 * This is the layer that decides what a show *does* — not what any individual
 * moment sounds like, which the analyser already answered, but how the evening
 * is paced. It reads the analysis and emits lighting intents.
 *
 * The rules it works to are the ones a human operator works to:
 *
 *   Contrast is the product. A show that flashes constantly has no big moments
 *   because everything is a big moment. So the director keeps an explicit
 *   budget — a cap on accents per minute, a minimum gap, a recovery window
 *   after every drop — and spends it. When the budget is tight, the least
 *   convincing accents are the ones that go.
 *
 *   Rest is a decision, not an absence. Breakdowns, intros and outros get a
 *   deliberately restrained look with no accents at all. That is what makes the
 *   chorus after them land.
 *
 *   Anticipation beats reaction. Nothing fires in the bars immediately before a
 *   drop except the build-up's own arc, because a stray accent there spends the
 *   audience's attention a second before the moment that needed it.
 *
 *   Repeats look like repeats. Passages the analyser recognises as the same
 *   get the same pattern and the same palette rotation every time they return,
 *   so the second chorus reads as the chorus and not as a new idea.
 *
 * ## What the measurements changed
 *
 * Those four rules are unchanged. What changed is *what the thresholds read*.
 * Every decision below used to be a comparison against a percentile level
 * string ('low' / 'mid' / 'high') or against `mood.arousal`, because that was
 * all a document carried. It now carries separated stem envelopes, per-band
 * attack and decay, a loudness profile, timbre embeddings and a sixteen-way
 * subgenre distribution — so the questions are asked of the thing that actually
 * answers them:
 *
 *   *Is this passage carried by a voice or by a kick?*  The stems, not the
 *   section's loudness percentile. A sung chorus and an instrumental drop sit
 *   at the same level and want opposite looks.
 *
 *   *Should this accent be a stab or a strobe?*  The sub band's attack time and
 *   percussive share. Strobing at a slow, sustained bass smears the very
 *   transient the accent was marking.
 *
 *   *How hard may the rig work?*  A blend across the whole subgenre
 *   distribution rather than the winning label, floored by measured arousal.
 *   A near-tie used to resolve by three percent into `calm`, and `calm` turns
 *   the show off for the whole track.
 *
 *   *Is this the same passage as that one?*  MuQ's timbre embeddings, which
 *   recognise a returning chorus the structure labeller split in two.
 *
 * Everything the director emits is an intent; `render.js` turns intents into
 * the patches the Art-Net engine applies. The two are kept apart so this file
 * can be read as a set of decisions rather than as a stream of channel values.
 *
 * **Every measurement is optional.** A document from an older analyser, or from
 * a rig without the separation model, still plans a complete show: each reading
 * falls back to a coarser one and the score reports lower confidence, which the
 * passes below spend more conservatively.
 */

const { EVENT, deriveEvents, byType } = require('./musical-events');
const look = require('./look');
const { makeScore, hasScore, cosine, unit, list, finite } = require('./score');
const {
  INTENT, BURST, PRIORITY, scene, expression, color, accent, tempo, dark,
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
 *   levelBias   shifts the passage's measured weight up or down
 *   accents     may this role carry bar accents at all
 *   maxDivision ceiling on how far the beat clock subdivides here
 *   prefer      patterns to reach for first, when the rig has them
 */
const ROLE_PROFILE = {
  intro:     { levelBias: -0.18, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave', 'solid'] },
  verse:     { levelBias: 0,     accents: true,  maxDivision: 2, prefer: null },
  chorus:    { levelBias: 0.12,  accents: true,  maxDivision: 4, prefer: null },
  drop:      { levelBias: 0.15,  accents: true,  maxDivision: 4, prefer: null },
  bridge:    { levelBias: 0,     accents: true,  maxDivision: 2, prefer: null },
  breakdown: { levelBias: -0.20, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave'] },
  outro:     { levelBias: -0.18, accents: false, maxDivision: 1, prefer: ['ribbon', 'fade', 'wave', 'solid'] },
  unknown:   { levelBias: 0,     accents: true,  maxDivision: 4, prefer: null },
};

const RESTING_ROLES = new Set(['intro', 'outro', 'breakdown']);

// Accents allowed per minute at full drive, before the intensity fader scales
// it. Low on purpose — drops and build-ups carry the big moments and bar
// accents are garnish — but not as low as they were. The first pass at these
// numbers was a correction to an engine that fired roughly three times this
// and left the bursts meaning nothing; it overshot for a party rig, where one
// accent every nine seconds reads as the show having lost interest. These sit
// between the two: a driving track punctuates about every three seconds and a
// quiet one still barely at all.
const ACCENT_BUDGET = { dance: 20, moderate: 12, rock: 7, calm: 0, unknown: 10 };

// Seconds of quiet the director keeps after a drop, and before one.
const RECOVERY_SEC = 2.0;
const ANTICIPATION_SEC = 2.0;

// Minimum burst length. At 40 Hz DMX, 300 ms is about twelve frames plus two or
// three pulses of the fixture's own strobe channel — below that an LED par has
// not finished responding before it is told to stop.
const MIN_BURST_MS = 300;

// How often the continuous channel is re-read. Twice a second is fast enough to
// follow a swell and slow enough that the timeline stays a few hundred events
// rather than a few thousand; the engine interpolates between them at frame
// rate, so this is a sampling rate and not a step size.
const EXPRESSION_STEP_SEC = 0.5;

// Two passages count as the same idea past this timbre similarity. Set high on
// purpose: MuQ vectors for any two passages of one track are already close, and
// the mistake that matters is calling a verse a chorus.
const IDENTITY_SIMILARITY = 0.94;


class ShowDirector {
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
   * Returns `{ intents, palette, paletteName, paletteSize, context }`. The
   * intents are time sorted and have already been through the contrast pass, so
   * what comes out is what the show will actually do.
   */
  plan(analysis) {
    const context = this._context(normalise(analysis));

    const intents = [
      ...this._openingIntent(context),
      ...this._planTempo(context),
      ...this._planSections(context),
      ...this._planExpression(context),
      ...this._planBuildups(context),
      ...this._planDrops(context),
      ...this._planQuiet(context),
      ...this._planColourMoves(context),
      ...this._applyContrast(this._planAccents(context), context),
    ];

    // Low priority first, so that when two intents want the same millisecond
    // the stronger decision is the one the renderer applies last and therefore
    // the one that wins.
    intents.sort((a, b) => a.timeMs - b.timeMs || a.priority - b.priority);

    return {
      intents: this._dedupeTempo(intents),
      palette: context.palette,
      paletteName: context.paletteName,
      paletteSize: context.paletteSize,
      context,
    };
  }

  // ── Context ─────────────────────────────────────────────────────────────

  /**
   * Everything the planning passes need, derived once.
   *
   * Three judgement calls live here and nowhere else, so they cannot drift
   * apart between passes: the drive (how hard the rig is allowed to work), the
   * palette, and the character of each section.
   */
  _context(analysis) {
    const events = deriveEvents(analysis);
    const grouped = byType(events);
    const mood = analysis.mood || {};
    const score = makeScore(analysis);

    const { drive, tier } = look.driveFor(analysis, mood, score);
    const factor = this.intensity / 50;  // 0 … 2, with 50 as "normal"

    // The operator's fader scales the drive rather than sitting beside it, so
    // there is one number that answers "how hard is the rig working" and the
    // fader genuinely moves it. Clamped above 1 so a pushed fader cannot invent
    // a licence the music never gave.
    const effective = unit(drive * Math.min(1.35, Math.max(0, factor)));
    // Zero is the operator saying stop, and it is absolute.
    //
    // The `factor < 1.4` is the fader's one escape hatch, and it is deliberate:
    // pushing past 70 lifts a quiet track out of its restraint *for drops only*.
    // A fader that did nothing on a ballad is a fader the operator stops
    // trusting — but it buys drops, never accent density, because the budget
    // below is still zero at this drive. The track gets its big moments and
    // still does not strobe through its verses.
    const isCalm = this.intensity === 0 || (effective < 0.3 && factor < 1.4);
    const isLight = !isCalm && effective < 0.45;

    const sections = this._sections(analysis, { score, drive, isCalm });
    const identities = new Set(sections.map((s) => s.identity)).size;

    const paletteSize = this.paletteSize === 'auto'
      ? look.paletteSizeFor({ score, identities, mood })
      : this.paletteSize;
    const { palette, name: paletteName } = look.buildPalette({
      key: analysis.key, scale: analysis.scale, mood, score,
      paletteSize, colorPresets: this.colorPresets,
    });

    const meter = analysis.meter || 4;
    const downbeats = list(analysis.downbeats);
    const barSec = downbeats.length >= 2 ? (downbeats[1] - downbeats[0]) : null;
    const baseBpm = clampBpm(analysis.bpm);
    const duration = Math.max(0, finite(analysis.duration,
      Math.max(0, ...sections.map((s) => s.end))));

    return {
      analysis, events, grouped, mood, score, drive, tier, factor, effective,
      isCalm, isLight, palette, paletteName, paletteSize, meter, downbeats,
      barSec, baseBpm, duration, sections, identities,
      // Whether the document carries the continuous data at all. It decides how
      // a silence is expressed, and nothing else — every other pass degrades
      // inside itself rather than branching on this.
      continuous: hasScore(analysis),
      available: new Set(this.patterns.map((p) => p.id)),
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
      snapToDownbeatMs: this._snapper(downbeats, barSec),
      sectionAt: (t) => sections.find((s) => t >= s.start && t < s.end) || null,
    };
  }

  /**
   * Sections, with what is playing in them and which idea they belong to.
   *
   * Two things are attached here that the analyser does not provide directly.
   *
   * **Character** — the mean stem reading across the span. This replaces the
   * percentile level string as the input to every look decision. The level was
   * a statement about loudness relative to the rest of the track; it could not
   * distinguish a sung chorus from an instrumental drop, and those want
   * opposite looks.
   *
   * **Identity** — which earlier passage this one repeats. The structure
   * labeller's cluster label is trusted first because it is cheap and usually
   * right; where it disagrees or is missing, the timbre embeddings decide, and
   * they recognise a returning chorus the labeller happened to split in two.
   */
  _sections(analysis, { score, drive, isCalm }) {
    const raw = splitRestingAtDrops(list(analysis.segments), list(analysis.drops));
    if (!raw.length) return [];

    // Percentile levels are within-track, so a minimalist arrangement reads
    // `low` in every section even when it is genuinely energetic. The measured
    // energy is the corrective: it is absolute, and it is what the weight below
    // is actually built from.
    const memories = [];
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

      // How much of the rig this passage has earned, 0..1. Measured energy
      // leads; the analyser's own level is kept as a second opinion because it
      // knows the track's own distribution, which absolute energy does not.
      const fromLevel = { low: 0.2, mid: 0.5, high: 0.82 }[section.level];
      const measured = unit(character.energy, 0.45);
      let weight = fromLevel == null ? measured : measured * 0.65 + fromLevel * 0.35;
      weight = unit(weight + profile.levelBias);
      if (isCalm) weight = Math.min(weight, 0.5);

      return {
        ...section,
        index, role, profile, identity, character, vector,
        weight,
        rawLevel: section.level,
        // Kept because the segment schema and the operator-facing views still
        // speak in levels; nothing in this file decides from it any more.
        level: weight >= 0.68 ? 'high' : weight >= 0.36 ? 'mid' : 'low',
        resting: RESTING_ROLES.has(role) || weight < 0.18,
        start,
        end,
        drive: unit(drive * (0.55 + weight * 0.6)),
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
    const stability = finite(analysis.tempoStability, 1);
    const curve = list(analysis.tempoCurve);
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
   * Patterns and palette offsets are keyed on the section's *identity*, so a
   * returning chorus returns to the same look whether the analyser recognised
   * it by cluster label or by timbre.
   */
  _planSections(context) {
    const { sections, palette, barSec, available } = context;
    const intents = [];
    const patternByIdentity = new Map();
    let lastKey = '';

    for (const section of sections) {
      const timeMs = context.snapToDownbeatMs(section.start);
      const pattern = this._patternFor(section, patternByIdentity, context);
      const colours = coloursFor(section.identity, palette);
      const beatDivision = this._divisionFor(section, context);

      // strobeSpeed is only honoured when the pattern *is* the strobe, so it is
      // zeroed otherwise — a leftover speed from a build-up peak would
      // otherwise bleed into the next section.
      const strobeSpeed = pattern === 'strobe'
        ? look.strobeSpeedFor(section.character, context.score, section.drive) : 0;
      const strobeFunction = section.resting ? 'standard'
        : look.strobeFunctionFor(section.character, context.score);

      const key = `${pattern}|${colours.join('|')}|${strobeSpeed}|${strobeFunction}|${beatDivision}`;
      if (key === lastKey) continue;
      lastKey = key;

      intents.push(scene(timeMs, {
        pattern, colors: colours, beatDivision, strobeSpeed, strobeFunction,
        role: section.role, label: section.label, level: section.level,
        identity: section.identity,
      }, { source: `section:${section.role}` }));

      intents.push(...this._rotateWithin(section, {
        pattern, colours, beatDivision, strobeFunction, timeMs,
      }, context));

      // `solid` is a static look. Four bars of it is a held moment; thirty
      // seconds of it is the show having stalled.
      if (pattern === 'solid' && barSec) {
        const followUpMs = timeMs + Math.round(barSec * 4 * 1000);
        if (followUpMs + 500 < section.end * 1000) {
          const followUp = ['ribbon', 'fade', 'wave'].find((p) => available.has(p));
          if (followUp) {
            intents.push(scene(followUpMs, {
              pattern: followUp, colors: colours, beatDivision,
              strobeSpeed: 0, strobeFunction,
            }, { source: 'section:solid-followup', priority: PRIORITY.ROTATION }));
          }
        }
      }
    }
    return intents;
  }

  _patternFor(section, patternByIdentity, context) {
    if (patternByIdentity.has(section.identity)) return patternByIdentity.get(section.identity);

    const { available, mood, score } = context;
    // A role with a preference gets it when the rig has it: an intro that opens
    // on a chase is an intro that has given away the chorus.
    const preferred = section.profile.prefer
      && section.profile.prefer.find((p) => available.has(p));
    const pattern = preferred || look.pickPattern({
      character: section.character, available, score,
      seed: section.identity, drive: section.drive,
      dance: unit(mood.danceability, 0.5),
    });
    patternByIdentity.set(section.identity, pattern);
    return pattern;
  }

  /**
   * How far the beat clock subdivides in this section.
   *
   * This is the main lever for intensity that is not a strobe: the same pattern
   * at four times the beat rate reads as far more aggressive without a single
   * extra flash.
   *
   * It is now gated on the measured pulse rather than on arousal, because those
   * are different questions. Arousal says how excited the track is; `pulse` says
   * whether there is a beat steady enough to subdivide, and subdividing one
   * that is not there is how a rubato passage ends up looking like a fault.
   * Triple metre stays on quarters throughout — subdividing 3/4 by two puts the
   * rig on the off-beats of the bar.
   */
  _divisionFor(section, context) {
    const { meter, score, isCalm } = context;
    if (isCalm || meter === 3 || context.factor < 0.5) return 1;
    if (section.resting) return 1;

    const pulse = unit(section.character.pulse, 0.4);
    const stability = unit(score.stability, 0.8);
    if (stability < 0.55 || pulse < 0.42) return 1;

    // These gates used to sit where only a confidently classified EDM track
    // could clear them, so most of a party playlist ran the whole night on
    // quarters — the same pattern stepping once a beat, which is the single
    // biggest reason a show reads as slow. Eighths are the normal case for a
    // danceable passage, not the exception, and sixteenths belong to a chorus
    // that is genuinely going for it.
    let division = 1;
    if (section.drive >= 0.55 && pulse >= 0.5) division = 2;
    if (section.drive >= 0.72 && pulse >= 0.62 && section.weight >= 0.62) division = 4;
    return Math.min(division, section.profile.maxDivision);
  }

  /**
   * Rotate through alternate patterns inside a long section.
   *
   * A section locked to one look for thirty seconds relies entirely on accents
   * for variation, which is exactly the budget the show is trying to save.
   * Repeated sections rotate identically — the rotation is seeded from the
   * identity — so verse one and verse two stay in step visually.
   */
  _rotateWithin(section, current, context) {
    const { barSec, isCalm, available, mood, score, drops, buildups } = context;
    if (isCalm || !barSec || current.pattern === 'solid' || section.resting) return [];

    // How long a look holds before it stops developing and starts repeating.
    // Busier passages turn over faster, which is the same instinct as a longer
    // hold on a verse than on a drop, expressed as a number.
    // Sixteen bars is half a minute of one look at a party tempo, which is long
    // past the point where a static rig stops developing and starts repeating.
    let rotateBars = section.drive >= 0.8 ? 2 : section.drive >= 0.6 ? 4 : 8;
    if (context.factor > 0) rotateBars = Math.max(2, Math.round(rotateBars / context.factor));

    const endMs = Math.round(section.end * 1000);
    const stepMs = Math.round(rotateBars * barSec * 1000);
    // A single mid-section swap reads as a glitch rather than as development;
    // only rotate when there is room for at least two full cycles.
    if (endMs - current.timeMs < stepMs * 2) return [];

    // Walk seeds with a coprime stride until two *distinct* alternates turn up.
    // Fixed offsets collide whenever both land on the same slot of a short pool.
    const alternates = [];
    const seen = new Set([current.pattern]);
    for (let step = 1; step < 24 && alternates.length < 2; step++) {
      const candidate = look.pickPattern({
        character: section.character, available, score,
        seed: section.identity * 7 + step * 13, drive: section.drive,
        dance: unit(mood.danceability, 0.5),
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
        && at <= endOf(b) * 1000 + 200);
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
   * The continuous channel: what the rig is doing between decisions.
   *
   * This is the pass the stems made possible, and it is what stops the show
   * being a slideshow of scenes. Twice a second it reports what is playing —
   * how loud, how much of it is low end, whether a voice is present, how much
   * air is on top, how fast it is moving — and the engine interpolates towards
   * that at frame rate, underneath whatever pattern is running.
   *
   * The distinction that matters: none of this changes the *look*. It changes
   * how the look is being played. A chase running through a breakdown and the
   * same chase through the chorus after it are the same pattern in the same
   * colours, and they do not read as remotely the same thing.
   *
   * Nothing here touches the operator's master. A show that quietly rewrites
   * the fader is a show the operator cannot take back.
   */
  _planExpression(context) {
    const { score, duration, silences, breaks, buildups, vocals } = context;
    if (!(duration > 0)) return [];

    const intents = [];
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

      // Level is where the track's own dynamic range is spent. The exponent is
      // the point: a track with a wide range gets its quiet parts pushed
      // further down, and a brickwalled master — which has no range of its own
      // left — gets an almost linear map, because the rig has to supply the
      // dynamics the mastering removed.
      //
      // What changed is where that map *lands*. The old constants put a typical
      // party track at under half brightness for its whole length, so the rig
      // never read as being on — and the contrast the curve buys is worth
      // nothing if the top of it is dim.
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
        // How fast the rig travels. Driven by the pulse and by where the
        // build-up has got to, and pulled back on intimate music — a wide,
        // fast sweep over a close-mic'd vocal is the rig talking over it.
        motion: unit((0.2 + r.pulse * 0.45 + r.synth * 0.2 + progress * 0.35)
          * factor * (1 - intimate * 0.4)),
        // The measured release of the track's own low end, so the rig's decay
        // matches the music's rather than a constant someone picked.
        decay: bassDecay,
      }));
    }

    // Exact boundaries. A silence shorter than the sampling step would
    // otherwise be missed entirely, and a missed silence is the one failure an
    // audience always notices.
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

    // End the automatic show in darkness. Stopping releases the channel; this
    // is so the last thing the rig does is a decision rather than a hold.
    intents.push(expression(duration * 1000, { level: 0 },
      { source: 'end', priority: PRIORITY.SILENCE_HARD }));

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
   * How far the roll subdivides is *measured*, not assumed. The analyser
   * already counted it — that is what `buildups[].subdivision` is — and the
   * onset-density fallback below only runs for documents that predate it.
   */
  _planBuildups(context) {
    const { buildups, palette, meter, isCalm, factor, available, analysis, baseBpm } = context;
    if (isCalm || factor < 0.4) return [];

    const stability = finite(analysis.tempoStability, 1);
    const intents = [];

    for (const event of buildups) {
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
        const tensionPattern = ['ribbon', 'fade', 'wave'].find((p) => available.has(p)) || 'fade';
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
   * Drops.
   *
   * The variant used to rotate by index so consecutive drops felt distinct,
   * which is a reasonable thing to do when you know nothing about them. The
   * analyser now says what kind of drop each one is, so the choice is made from
   * the music instead — and the result is that the same drop gets the same
   * gesture every time it comes round, which is what a designer would do:
   *
   *   slam         the drop arrives out of a deep breakdown. The bigger the
   *                hole it came out of, the bigger the arrival.
   *   color-burst  a drop that sustains rather than punches — the palette
   *                colour carries the impact and the movement holds it.
   *   punch        a small or unconfident rise. No burst at all; pattern and
   *                beat division do the work.
   *
   * A solid anchor at the exact instant is always emitted first so every
   * fixture snaps to the same hot colour before anything else happens.
   */
  _planDrops(context) {
    const { drops, palette, meter, isCalm, isLight, factor, score, available } = context;
    if (isCalm) return [];

    const intents = [];

    drops.forEach((event, index) => {
      const timeMs = Math.round(event.t * 1000);
      const data = event.data || {};
      const kind = data.kind || 'hype';
      if (factor < 0.6 && kind !== 'proper') return;
      if (isLight && kind !== 'proper') return;
      // A drop detected inside a silence is a contradiction, and the silence is
      // the more reliable of the two measurements — it is read off the envelope
      // rather than inferred from a rise. Firing the biggest gesture in the
      // show into a hole in the track is the worst way to resolve it.
      if (spanAt(context.silences, event.t) || spanAt(context.breaks, event.t)) return;

      const confidence = unit((event.confidence || 0.5)
        + (data.snapTo === 'downbeat' ? 0.1 : 0));
      const section = context.sectionAt(event.t);
      const character = section ? section.character : score.sample(event.t);
      // The drive at this instant, not the track's: a drop into a sparse
      // section is still a drop, but it is not the same drop as one into a
      // wall of sound.
      const drive = unit(context.effective * (0.7 + unit(character.energy) * 0.45));

      const colours = dropColours(index, palette);
      intents.push(scene(timeMs, {
        pattern: 'solid', colors: colours, strobeSpeed: 0,
        strobeFunction: 'standard', beatDivision: meter === 3 ? 1 : 4,
      }, { source: 'drop:anchor', priority: PRIORITY.DROP }));

      if (kind !== 'proper') {
        const burst = look.burstFor({ moment: 'drop', character, score, drive: drive * 0.8 });
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

      // How deep a hole the drop came out of, and how much it sustains after.
      // Both are measured by the analyser and both change what the moment is.
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
        const burst = look.burstFor({ moment: 'drop', character, score, drive });
        // The blinder is the one gesture that uses the whole rig at full, so it
        // is spent only where the music has both the confidence and the hole to
        // justify it.
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
        const burst = look.burstFor({ moment: 'drop', character, score, drive: drive * 0.9 });
        const strobeMs = Math.round((600 + confidence * 400) * Math.min(1.5, factor));
        intents.push(accent(timeMs + 1, burst, Math.max(MIN_BURST_MS, strobeMs),
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
    const { silences, breaks, palette, available, isCalm, continuous } = context;
    const intents = [];

    // How a silence is closed depends on what the rig has to close it with.
    //
    // With the expression channel running, level 0 is the right answer: the
    // light goes out and comes back without the look changing underneath it.
    // Patching the colour to blackout as well would leave the rig sitting on
    // the blackout colour when the music returns, until whatever scene comes
    // next happens to restore it — which on a two-bar stutter is the rest of
    // the section. Without a continuous channel there is nothing else to dim
    // with, and the colour patch is the only way to go dark at all.
    if (!continuous) {
      for (const event of silences) {
        intents.push(dark(Math.round(event.t * 1000), {
          source: 'silence', priority: PRIORITY.SILENCE, colorIndex: this.blackoutIndex,
        }));
      }
    }

    if (!isCalm) {
      for (const event of breaks) {
        const pattern = ['ribbon', 'fade', 'wave', 'solid'].find((p) => available.has(p));
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
   * Three musical reasons to move colour, in decreasing order of how sure we
   * are that something actually changed:
   *
   *   a melody change — a chord change is *the* musical reason to move colour,
   *   and following it makes the palette feel like it is listening;
   *
   *   a timbre change the envelopes cannot see. This is what the MuQ embeddings
   *   add: a track that swaps its synth for a piano at the same level, in the
   *   same band, with the same groove, has plainly changed, and nothing else in
   *   the document notices;
   *
   *   a bass hit, throttled hard, for documents that carry neither.
   *
   * Driving tracks are excluded from the bass-hit path: they already express
   * groove through beat division, and colour flips on top read as twitchy
   * rather than as energetic.
   */
  _planColourMoves(context) {
    const { melodies, bassHits, bars, palette, score, drops, buildups, isCalm } = context;
    const intents = [];
    const inDrop = (ms) => drops.some((d) => {
      const delta = ms - d.t * 1000;
      return delta >= -1500 && delta <= 2500;
    });
    const inBuildup = (ms) => buildups.some((b) => ms >= b.t * 1000 && ms <= endOf(b) * 1000);

    let step = 0;
    const emit = (t, source) => {
      const section = context.sectionAt(t);
      const colours = coloursFor(section ? section.identity : 0, palette);
      intents.push(color(t * 1000, [colours[look.goldenStep(step, colours.length)]], { source }));
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

    // Timbre. Only on a bar line, so the move lands musically, and only when
    // the embeddings say the sound genuinely moved.
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
      // Only middling passages: a busy one already has movement and division
      // doing the work, and more on top just smears.
      if (!section || section.weight < 0.36 || section.weight > 0.68) continue;
      emit(event.t, 'bass-hit');
      lastMs = ms;
    }
    return intents;
  }

  /**
   * Candidate accents, before the budget is applied.
   *
   * Three sources, and they are proposals rather than decisions — the contrast
   * pass next door is what decides which the show can afford:
   *
   *   bar lines, so an accent always lands on beat one. Strong beats stand in
   *   when the downbeat grid is missing or the tracker was unsure of it.
   *   energy spikes, which are moments the track marked itself.
   *   bass hits, for the groove between them.
   *
   * The burst each one asks for comes from what is playing at that instant, not
   * from the track's tier — which is what lets a ballad have accents at all.
   * Every gesture in the vocabulary above `uv-wash` is a flash, and before
   * the soft ones existed a calm track's only options were "too loud" and
   * "nothing", so it always got nothing.
   */
  _planAccents(context) {
    const { bars, beats, spikes, bassHits, score, isCalm, analysis } = context;
    if (isCalm) return [];

    const dance = unit((context.mood || {}).danceability, 0.5);
    const candidates = [];
    const propose = (t, confidence, source, priority) => {
      const section = context.sectionAt(t);
      if (!section || !section.profile.accents || section.resting) return;
      if (section.drive < 0.28) return;
      const character = score.sample(t);
      const vocal = character.vocal > 0.55
        || context.vocals.some((v) => t >= v.t && t <= endOf(v));
      const burst = look.burstFor({
        moment: 'accent', character, score, drive: section.drive, vocal,
        // A compressed master has no headroom of its own left, so a blinder or
        // a white strobe on top of it has nothing to contrast against.
        headroom: score.crest >= 0.35,
      });
      // A hole wants to be as short as the transient it marks; a sustained low
      // end wants the light to ring on with it. That is the band's own decay,
      // measured, rather than a constant — and at a party tempo the percussive
      // end of it has to be tight, because anything past about an eighth of a
      // bar sits *across* the groove instead of on it.
      const durationMs = burst === BURST.KILL || burst === BURST.GLOW
        ? Math.round(110 + (1 - unit(score.articulation, 0.5)) * 190)
        : MIN_BURST_MS;
      candidates.push(accent(t * 1000, burst, Math.max(120, durationMs), {
        source, priority, confidence: unit(confidence, 0.5),
      }));
    };

    // Bar lines. The stride is the throttle: how many bars pass between
    // candidates, from how hard the passage is driving.
    const confidentBars = bars.length > 0
      && (analysis.downbeatConfidence == null || analysis.downbeatConfidence >= 0.10);
    if (confidentBars) {
      let index = 0;
      for (const bar of bars) {
        const section = context.sectionAt(bar.t);
        index++;
        if (!section) continue;
        const every = strideFor(section.drive, context.factor, dance);
        if (!every || index % every !== 0) continue;
        propose(bar.t, bar.confidence == null ? 0.5 : bar.confidence,
          'bar', PRIORITY.BAR_ACCENT);
      }
    } else {
      let lastT = -Infinity;
      for (let i = 0; i < beats.length; i++) {
        // Sub-400 ms coalescing: below that the rig is past DMX and LED
        // response time, and firing on every beat just smears into a blur.
        if (i + 1 < beats.length && (beats[i + 1].t - beats[i].t) < 0.4) i++;
        const beat = beats[i];
        if (!beat || beat.intensity < 0.6) continue;
        const section = context.sectionAt(beat.t);
        if (!section) continue;
        const every = strideFor(section.drive, context.factor, dance);
        if (!every) continue;
        // Four beats to the bar, so the same stride means the same density
        // whichever grid it came off.
        const minGap = every * 4 * (60 / Math.max(20, context.baseBpm));
        if (beat.t - lastT < minGap) continue;
        propose(beat.t, beat.confidence, 'beat', PRIORITY.BEAT_ACCENT);
        lastT = beat.t;
      }
    }

    // Moments the track marked itself. Worth more than a bar line, because
    // something actually happened.
    for (const event of spikes) propose(event.t, event.confidence, 'spike', PRIORITY.BAR_ACCENT);
    for (const event of bassHits) {
      if (event.confidence < 0.7) continue;
      propose(event.t, event.confidence * 0.8, 'instrument', PRIORITY.BEAT_ACCENT);
    }

    return candidates;
  }

  /**
   * The contrast pass — the difference between a show and a strobe machine.
   *
   * Every accent the passes above proposed is a *request*. This is where the
   * show decides which ones it can afford, in one place, with the whole track
   * in view. Five rules:
   *
   *   anticipation  nothing in the couple of seconds before a drop. The
   *                 build-up's own arc owns that window, and an accent there
   *                 spends attention a moment before the payoff needed it.
   *   recovery      nothing for three seconds after a drop. The drop *is* the
   *                 statement; carrying on flashing over it reads as the rig
   *                 not having noticed.
   *   quiet         nothing inside a silence or a break. Those are the contrast
   *                 the rest of the show is spending.
   *   separation    a burst must finish, plus a safety gap, before the next one
   *                 starts — otherwise the first is clipped in half before the
   *                 fixtures have finished responding to it.
   *   budget        a hard cap on accents per rolling minute.
   *
   * Candidates are considered **best first**, not in time order. That is the
   * change from the previous pass, which walked the track from the start and so
   * spent its budget on whatever happened to come first; a convincing accent
   * ninety seconds in lost to three unconvincing ones in the opening verse.
   * Confidence is what "best" means, weighted by how much the document is worth
   * trusting at all.
   *
   * Drop accents are exempt: they are the moments the budget exists to protect.
   */
  _applyContrast(accents, context) {
    const { drops, vocals, silences, breaks, tier, factor, effective, score } = context;
    const base = ACCENT_BUDGET[tier] != null ? ACCENT_BUDGET[tier] : ACCENT_BUDGET.unknown;
    // Scaled by where the drive sits inside its tier, so two dance tracks at
    // opposite ends of the tier do not get identical accent density. Never
    // above the tier's own ceiling.
    const budgetPerMinute = Math.round(base
      * Math.min(2, Math.max(0, factor))
      * (0.55 + unit(effective) * 0.45));

    const dropTimes = drops.map((d) => d.t * 1000);
    const kept = [];
    const trust = 0.6 + 0.4 * unit(score.confidence, 0.8);

    const ranked = accents.slice().sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const byConfidence = (b.confidence || 0) - (a.confidence || 0);
      return byConfidence || a.timeMs - b.timeMs;
    });

    for (const intent of ranked) {
      if (intent.priority >= PRIORITY.DROP) { kept.push(intent); continue; }
      if (intent.confidence * trust < 0.3) continue;

      const t = intent.timeMs;
      if (dropTimes.some((d) => t >= d - ANTICIPATION_SEC * 1000 && t < d)) continue;
      if (dropTimes.some((d) => t >= d && t <= d + RECOVERY_SEC * 1000)) continue;
      if (spanAt(silences, t / 1000) || spanAt(breaks, t / 1000)) continue;

      // A sung phrase wants atmosphere. Strobing over a vocal is the single
      // most common way an automatic show announces that it is automatic — so
      // only the soft end of the vocabulary is allowed across one, and even
      // then at a fraction of the usual rate.
      const inVocal = vocals.some((v) => t >= v.t * 1000 && t <= endOf(v) * 1000);
      if (inVocal) {
        if (intent.burst !== BURST.GLOW && intent.burst !== BURST.KILL) continue;
        if (kept.some((k) => Math.abs(k.timeMs - t) < 8000)) continue;
      }

      if (overlaps(kept, intent)) continue;
      if (budgetPerMinute <= 0) continue;
      if (exceedsBudget(kept, intent, budgetPerMinute)) continue;

      kept.push(intent);
    }

    return kept.sort((a, b) => a.timeMs - b.timeMs);
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


// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Flatten the two shapes an analysis document arrives in.
 *
 * The nested sections are the current schema; the flat fields are the
 * compatibility surface the web client and the cache still read. Doing this
 * once here is what lets every pass below name one field.
 */
function normalise(analysis) {
  const a = analysis || {};
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

/** The end of a span event, however the document spelled it. */
function endOf(event) {
  const end = event && event.data ? event.data.end : undefined;
  if (Number.isFinite(end)) return end;
  return finite(event && event.t) + finite(event && event.duration);
}

/** The span containing `t`, or undefined. */
function spanAt(events, t) {
  return events.find((e) => t >= e.t && t < endOf(e));
}

/**
 * Split a resting section at a drop it has no business containing.
 *
 * A section labelled `intro` that runs for seventy seconds with a drop the
 * analyser is certain about in the middle of it is two measurements
 * disagreeing, and it is worth naming which one to believe.
 *
 * The drop is read off the envelope — a measured rise out of a measured hole,
 * with a confidence attached. The role comes from clustering beat-synchronous
 * features and then naming the clusters, and the failure it actually has in the
 * wild is exactly this one: the whole first act of a track collapses into a
 * single `intro`. Measured against a cached set, five of twenty-eight drops
 * landed inside a section the director had already decided was resting.
 *
 * So the drop wins. The part before it keeps the resting role and stays a
 * genuine intro; the part after becomes the passage the drop launched. Without
 * this the director fired the biggest gesture it has into a section it had
 * decided deserved no accents, no subdivision and a level cut — and then went
 * on resting through what was often half the track.
 */
function splitRestingAtDrops(raw, drops) {
  if (!raw.length || !drops.length) return raw;
  // A copy: a boundary correction below rewrites the *next* segment, and the
  // array handed in belongs to the analysis document the cache holds.
  const segments = raw.slice();

  // Both halves have to survive as passages in their own right. A cut four
  // seconds from the top of a section is a boundary nudge, not a rearrangement.
  const MIN_HEAD_SEC = 4;
  const MIN_TAIL_SEC = 8;

  // A `hype` drop is a small one and does not get to re-role a passage; a
  // document that predates the kind field is judged on its confidence alone.
  const qualifies = (d, from, to) => d && finite(d.confidence, 0) >= 0.6
    && d.kind !== 'hype' && d.t >= from && d.t <= to;

  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const section = segments[i];
    const start = finite(section.start);
    const end = Math.max(start, finite(section.end));
    if (!RESTING_ROLES.has(section.role || 'unknown')) { out.push(section); continue; }

    // A drop in the last seconds of a resting section, with a working section
    // straight after it, is not a section that needs splitting — it is a
    // boundary that landed a bar or two late. Ending the rest at the drop is
    // the same correction the downbeat snapper makes, from better evidence.
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
      // Named for what the music did rather than for the cluster the label came
      // from. The label is dropped with it so the identity pass reads this as a
      // new idea by its timbre: it is not the intro coming back.
      role: 'drop',
      label: null,
      // The percentile belonged to the whole original span, most of which was
      // the quiet half. Measured energy leads the weight anyway; this stops the
      // intro's own level dragging the tail back down as a second opinion.
      level: section.level === 'low' ? 'mid' : section.level,
    });
  }
  return out;
}

/** Four colour slots for a passage, offset so each identity reads differently. */
function coloursFor(identity, palette) {
  if (!palette.length) return [0, 0, 0, 0];
  const base = look.goldenStep(identity, palette.length);
  const at = (offset) => palette[(base + offset) % palette.length];
  return [
    at(0),
    palette.length >= 2 ? at(1) : at(0),
    palette.length >= 3 ? at(2) : at(0),
    palette.length >= 4 ? at(3) : at(1),
  ];
}

/** A drop's colours: the palette's most separated pair, walked per drop. */
function dropColours(index, palette) {
  const length = palette.length;
  if (!length) return [0, 0, 0, 0];
  const slot = look.goldenStep(index, length);
  const opposite = Math.max(1, Math.floor(length / 2));
  return [
    palette[slot] || 0,
    length >= 2 ? palette[(slot + opposite) % length] : palette[slot] || 0,
    length >= 3 ? palette[(slot + 2) % length] : palette[slot] || 0,
    length >= 4 ? palette[(slot + 3) % length] : palette[slot] || 0,
  ];
}

/**
 * How many bars pass between accent candidates.
 *
 * One continuous curve where there used to be a table per tier: a driving,
 * danceable passage proposes on every bar and a sparse one every sixteen, with
 * everything in between actually reachable rather than snapped to one of four
 * rows. Zero means "propose nothing here".
 */
function strideFor(drive, factor, dance) {
  if (drive < 0.3) return 0;
  const push = drive * 0.75 + dance * 0.25;
  const bars = Math.round(2 ** (4.2 - push * 3.2));   // 18 bars at 0, 2 at 1
  const scaled = factor > 0 ? bars / factor : bars * 4;
  return Math.max(1, Math.min(64, Math.round(scaled)));
}

/** Would this burst start before an already-kept one has finished? */
function overlaps(kept, intent) {
  const SAFETY_MS = 60;
  return kept.some((k) => intent.timeMs < k.timeMs + k.durationMs + SAFETY_MS
    && k.timeMs < intent.timeMs + intent.durationMs + SAFETY_MS);
}

/**
 * Would keeping this accent put any rolling minute over budget?
 *
 * Checked against every window that could contain it rather than only the
 * minute before it: candidates arrive best-first rather than in time order, so
 * a later accent can be the one that overfills an earlier window.
 */
function exceedsBudget(kept, intent, budgetPerMinute) {
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

/**
 * How a build-up actually accelerates.
 *
 * Two independent things happen in the seconds before a drop and they need
 * separate answers:
 *
 *   The roll. Standard production practice is to double the *subdivision* at
 *   constant tempo — a snare on quarters, then eighths, then sixteenths,
 *   sometimes thirty-seconds. That is what an audience hears as "speeding up",
 *   and it never touches BPM. **The analyser measures this** and reports it as
 *   the build-up's `subdivision`; the onset-density count below is the fallback
 *   for documents written before it did.
 *
 *   The ramp. Some tracks genuinely change tempo into a drop, and the beat
 *   clock has to follow or the rig drifts out of time at the most exposed
 *   moment of the song. Rarer than the roll, independent of it, and not in the
 *   document — so it is measured here from the tempo curve.
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

  // The analyser's own count, when the document carries one. Capped at 8 for a
  // limit of the rig rather than of restraint: renderDmx runs at 40 fps and the
  // pattern steps every (60000 / bpm) / division ms, so division 8 stays under
  // the frame rate up to 300 BPM while 16 passes it above 150 and loses steps
  // unevenly — which reads as irregular rather than as faster.
  const declared = list(analysis.buildups).find((b) => b
    && Math.abs(finite(b.start) - startSec) < 0.5);
  if (declared && Number.isFinite(declared.subdivision) && declared.subdivision >= 2) {
    out.peakDivision = Math.min(8, Math.max(2, Math.round(declared.subdivision)));
    out.riseDivision = Math.max(2, out.peakDivision / 2);
  }

  const onsets = list(analysis.onsets);
  if (!out.peakDivision && onsets.length) {
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
  ShowDirector, measureBuildup, normalise, strideFor, coloursFor,
  ROLE_PROFILE, ACCENT_BUDGET, RESTING_ROLES,
  TEMPO_RAMP_MIN_BPM, DRIFT_THRESHOLD, MIN_BURST_MS, EXPRESSION_STEP_SEC,
  IDENTITY_SIMILARITY, clampBpm, u8,
};
