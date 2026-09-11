'use strict';

/**
 * The look vocabulary: which colours a track gets, which pattern suits a
 * passage of it, and how hard the rig is allowed to work.
 *
 * Split out of the director so that "what does this music look like" is one
 * decision with one home, testable without building a timeline. The director
 * asks this module for a palette, a pattern and a burst; it never reaches into
 * the palette banks itself.
 *
 * Nothing here reads the audio. It reads the *measurements* — the score's
 * envelopes, the subgenre distribution, the mood words — and turns them into
 * rig-facing choices.
 *
 * One idea runs through the whole file, and it is what changed when the
 * analyser started returning distributions instead of labels: **evidence is
 * blended, not switched on.** Every table below maps a subgenre to what it
 * votes for, and a track's vote is its share of the distribution. A track that
 * is two thirds house and one third disco does not "become" house — it lands
 * between them, which is where it actually sounds like it is.
 */

const { paletteBankForSize } = require('../server/palettes');
const { blend, unit } = require('./score');

// ── How hard the rig works ──────────────────────────────────────────────────
//
// `drive` is the single most consequential number in the show: it is what
// decides whether the rig strobes at all. Each subgenre votes for one, and the
// track's drive is the weighted mean of the votes it actually earned.
//
// This used to be a four-way tier looked up from the winning label, which had a
// failure mode the distribution fixes. A near-tie between `ambient` and `funk`
// resolved to one of them by a three-percent margin, and `ambient` meant the
// show turned off for the whole track. Averaging cannot do that: a track that
// cannot decide between the two lands in the middle and gets a middling show,
// which is the honest answer to an ambiguous question.
const SUBGENRE_DRIVE = {
  edm: 1.0, dubstep: 1.0, trance: 0.9, disco: 0.85,
  hiphop: 0.62, pop: 0.6, funk: 0.62,
  metal: 0.52, rock: 0.46, reggae: 0.4, latin: 0.5, country: 0.34,
  folk: 0.16, jazz: 0.15, ambient: 0.1, classical: 0.05,
};

// Where a drive lands as a coarse label. The tiers survive because the accent
// budget and the operator-facing report are both easier to reason about in
// four names than in a float — but every decision inside the director reads
// the number, not the name.
const TIER_FLOOR = { dance: 0.72, moderate: 0.55, rock: 0.32, calm: 0 };

// Palette banks each subgenre reaches for, best first. Blended across the
// distribution and then scored against the mood words below, so the palette is
// the one place where the classifier and MuQ-MuLan both get a say.
// Six deep rather than three, because the depth is what stops a night sounding
// like one long track. Three preferences and a scoring pass that mostly agrees
// with itself means two house records an hour apart get the same look, and the
// audience reads that as the rig having stopped listening. The electronic rows
// lead with the white-forward banks: that music is lit white far more than a
// hue-first catalogue suggests, and on a rig with no moving heads white is the
// only way to read as hard.
const SUBGENRE_PALETTES = {
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

// Pattern pools per subgenre, used as a bias rather than as a filter: the
// measured character below decides *what kind* of pattern the passage wants,
// and this decides which of those the genre would reach for.
const SUBGENRE_PATTERNS = {
  edm:       ['pairs', 'runner', 'ensemble', 'split', 'stack-up', 'random-flash', 'hit', 'sections'],
  dubstep:   ['random-flash', 'stack-up', 'split', 'pairs', 'ensemble', 'hit', 'sections'],
  trance:    ['ribbon', 'sparkle', 'wave', 'twinkle', 'runner', 'ensemble', 'sections'],
  disco:     ['ping-pong', 'chase', 'sparkle', 'pairs', 'sections', 'split'],
  hiphop:    ['pairs', 'split', 'ensemble', 'stack-up', 'runner', 'sections'],
  pop:       ['ping-pong', 'wave', 'ensemble', 'sparkle', 'pairs', 'split'],
  funk:      ['ping-pong', 'pairs', 'runner', 'chase', 'ensemble', 'sections', 'split'],
  rock:      ['chase', 'runner', 'pairs', 'ping-pong', 'stack-up', 'ensemble'],
  metal:     ['stack-up', 'split', 'random-flash', 'runner', 'pairs', 'hit'],
  country:   ['wave', 'chase', 'runner', 'ping-pong', 'fade', 'ribbon'],
  reggae:    ['wave', 'fade', 'ribbon', 'chase', 'ping-pong', 'pairs'],
  latin:     ['ping-pong', 'runner', 'chase', 'pairs', 'wave', 'ensemble'],
  jazz:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle'],
  classical: ['ribbon', 'solid', 'fade', 'wave', 'twinkle'],
  folk:      ['ribbon', 'solid', 'fade', 'wave', 'twinkle'],
  ambient:   ['ribbon', 'solid', 'fade', 'wave', 'twinkle', 'sparkle'],
};

// What MuQ-MuLan's mood words say about colour. Two words per bank, because a
// single similarity is noise and an agreeing pair is evidence.
//
// Every bank has a pair, and that is the fix for the failure this table used to
// cause. It covered six banks out of sixteen while outscoring the genre vote,
// so the mood words did not *inform* the palette — they chose it, from a sixth
// of the catalogue. Over a set of real tracks the whole thing collapsed onto
// two looks: `desert` for anything the model called warm or organic and
// `solarPunch` for anything it called euphoric, which between them is most
// party music. Twelve tracks across six genres came out as two palettes.
//
// No pair is used twice, so the table can actually separate the banks it scores
// rather than electing several of them at once.
const SEMANTIC_PALETTES = {
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

// Fallback palette preferences when nothing has classified the track, mapped
// onto Russell's circumplex of affect (arousal × valence):
//
//                    high arousal
//                         │
//       angry / tense    ─┼─   excited / happy
//  low valence ───────────┼─────────── high valence
//       sad / reflective  │    content / calm
//                    low arousal
const CIRCUMPLEX_TETRADS = {
  highPos: ['sunsetDrive', 'candyPop', 'tropical', 'solarPunch'],
  highNeg: ['volcanic', 'noirUv', 'halloween', 'synthwave'],
  lowPos:  ['desert', 'emeraldCity', 'lunar', 'royal'],
  lowNeg:  ['deepOcean', 'arctic', 'aurora', 'lunar'],
};

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Which of the twelve pitch classes a key string names.
 *
 * The document spells a key as `"F# minor"`, not `"F#"`, and matching the whole
 * string against the table above returned -1 for every track that has ever been
 * analysed. Floored at zero, that made every track read as C — so the key, the
 * one reading in the palette that separates two records of the same genre in
 * the same mood, never moved anything at all. Two house tracks got the same
 * look because as far as this file was concerned they were in the same key.
 *
 * Written to survive the spellings the analyser and the clients actually use:
 * a bare pitch class, a pitch class and a mode, and a flat rather than a sharp.
 */
const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

function keyIndexOf(key) {
  const token = String(key == null ? '' : key).trim().split(/[\s/|-]+/)[0];
  if (!token) return 0;
  const pitch = token[0].toUpperCase() + token.slice(1).replace(/[^#b]/g, '');
  return Math.max(0, KEYS.indexOf(FLATS[pitch] || pitch));
}

// Patterns that lock to the pulse, and patterns that float over it. `ensemble`
// and `ribbon` belong to neither: they are driven by the expression channel at
// frame rate rather than stepped by the beat clock, so they read as whatever
// the music is doing and suit both.
const RHYTHMIC = new Set(['chase', 'chase-rev', 'runner', 'pairs', 'ping-pong',
  'split', 'sections', 'stack-up', 'random-flash', 'hit', 'color-cycle']);
const FLOWY = new Set(['solid', 'fade', 'wave', 'sparkle', 'twinkle']);
const EXPRESSIVE = new Set(['ensemble', 'ribbon']);

/**
 * How hard the rig may work on this track, 0..1, and the tier that names it.
 *
 * Three sources of evidence, in decreasing order of how much they know:
 *
 *   the subgenre distribution, weighted by how much the classifier is worth
 *   trusting (`score.genreTrust` folds in which model answered and how
 *   concentrated its answer was);
 *
 *   the analyser's own declared style, for documents that carry a label but no
 *   distribution;
 *
 *   arousal and danceability, which are measured rather than classified and so
 *   are never wrong about the track — only about what it means.
 *
 * The measured floor is not a fallback. It applies even to a confident label,
 * because a classifier calling a track `jazz` does not make its measured
 * arousal of 0.9 untrue, and lighting a loud track like a ballad is the most
 * visible failure this engine has.
 */
function driveFor(analysis, mood, score) {
  const arousal = unit(mood && mood.arousal, 0.5);
  const dance = unit(mood && mood.danceability, 0.5);
  // What the signal alone would ask for. Danceability matters as much as
  // arousal: a loud track with no findable pulse wants movement, not a chase.
  const measured = unit(0.15 + arousal * 0.55 + dance * 0.3);

  const votes = blend(score ? score.subgenre : {}, SUBGENRE_DRIVE);
  let classified = null;
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
    // No distribution, but the document still declares a style. That is worth
    // most of what a distribution is worth — it is the same classifier's answer
    // with the shape thrown away — so it is trusted by its own confidence
    // rather than dismissed. Dismissing it is how a document written by an
    // older analyser lost its style entirely and got lit from its tempo.
    const genre = (analysis && analysis.genre) || {};
    const fromStyle = { dance: 0.85, moderate: 0.6, rock: 0.42, calm: 0.12 }[genre.style];
    if (fromStyle != null) {
      classified = fromStyle;
      trust = unit(genre.confidence ?? genre.labelConf, 0.6) * 0.9;
    }
  }

  const drive = classified == null ? measured
    : classified * trust + measured * (1 - trust);
  // The floor. A track measured as plainly energetic keeps at least half of
  // what its own signal asked for, whatever it was called.
  const floored = Math.max(drive, measured * 0.65);
  return { drive: unit(floored), tier: tierOf(floored), measured, classified, trust };
}

function tierOf(drive) {
  return drive >= TIER_FLOOR.dance ? 'dance'
    : drive >= TIER_FLOOR.moderate ? 'moderate'
      : drive >= TIER_FLOOR.rock ? 'rock' : 'calm';
}

/**
 * One coherent palette for the whole track.
 *
 * Locked for the song's full duration on purpose: a show that re-picks colours
 * per section has no identity, and coming back to the chorus has to *look* like
 * coming back to the chorus.
 *
 * Three kinds of evidence are scored into one table rather than one of them
 * winning outright:
 *
 *   the subgenre distribution — what music like this usually looks like;
 *   MuQ-MuLan's mood words — what this particular track sounds like, which is
 *   the only reading that can tell two house tracks apart;
 *   key and mood — always present, so it is what breaks ties and what answers
 *   when nothing has classified anything.
 *
 * The key rotates which entry of a genre's row leads, so two tracks that score
 * the same genre in different keys diverge. That rotation is load-bearing: a
 * genre row is six banks the genre is happy with, and without it the first one
 * wins every track that scores that genre, which is what makes a night of one
 * genre a night of one palette.
 */
function buildPalette({ key, scale, mood = {}, score = null, paletteSize = 4,
  colorPresets = null }) {
  const bank = paletteBankForSize(paletteSize);
  const scores = new Map();
  const add = (name, weight) => {
    if (!bank[name] || !(weight > 0)) return;
    scores.set(name, (scores.get(name) || 0) + weight);
  };

  const keyIndex = keyIndexOf(key);

  // Genre: the leading preference is worth its full weight and each one behind
  // it progressively less, so a bank two subgenres both list second can still
  // win.
  //
  // Which preference *leads* is rotated by the key, and that rotation is the
  // answer to the complaint that every record of one genre looks the same. All
  // six entries in a row are banks the genre is happy with — that is what the
  // row means — but a fixed order hands the first one to every track that
  // scores that genre, so a night of house is a night of one palette. Rotating
  // the entry point spends the whole row across an evening while leaving each
  // individual track's choice fixed and repeatable.
  const trust = unit(score && score.genreTrust);
  if (trust > 0) {
    const votes = blend(score.subgenre, SUBGENRE_PALETTES,
      (name, subgenre, ranked) => {
        const rank = (ranked.indexOf(name) - keyIndex + ranked.length * 2) % ranked.length;
        return 1 / (1 + rank);
      });
    for (const [name, weight] of votes) add(name, weight * trust * 3.0);
  }

  // Mood words: only an agreeing pair counts, and the pair is worth what its
  // *weaker* word is worth.
  //
  // That last part is the whole of it. This used to score the sum, which a
  // single word at full could carry over the line on its own — and the words
  // are min-max normalised within the track, so the top one is *always* at
  // full. Every bank listing this track's top word therefore got elected, and
  // since party music is reliably "euphoric" and "warm", the handful of banks
  // pairing those two won almost every track in a set: thirteen of eighteen
  // came out `candyPop`. A word at 1.0 beside a word at 0.1 is not a pair
  // agreeing, it is one word and some noise, which is exactly what the
  // normalisation above warns about one level down.
  //
  // The scale sits alongside a confident genre rather than above it, so the two
  // readings argue rather than one of them deciding.
  const semantic = (score && score.semantic) || {};
  for (const [name, [first, second]] of Object.entries(SEMANTIC_PALETTES)) {
    const agreement = Math.min(unit(semantic[first]), unit(semantic[second]));
    if (agreement >= 0.5) add(name, (agreement - 0.4) * 1.6);
  }

  // Key and mood. This is the voice that answers when nothing has classified
  // anything, and it fades out as the other two find something to say.
  //
  // It used to be added flat, and adding a third vote to banks the first two
  // already liked is how one of them becomes unbeatable: `candyPop` sits in the
  // pop, disco and latin rows, its mood pair is the one every party record
  // scores, and it is in this quadrant — so it collected three times on most of
  // a playlist and won ten tracks out of seventeen. Scaling it by what is left
  // of the evidence keeps it decisive where it is the only reading available
  // and stops it stacking on top of readings that already agree.
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

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]
    || a[0].localeCompare(b[0]));

  // The top of the ranking, and only that.
  //
  // The key has already had its say twice above — it rotates which entry of a
  // genre's row leads, and it picks inside the circumplex quadrant. Letting it
  // break the final tie as well applied it a third time and undid the first:
  // the rotation would put `mint` on top for a track in F, and a tie-break on
  // the same index then walked one place down the list and took `candyPop`
  // straight back. One reading, applied once, where it means something.
  //
  // A style table pointing at a renamed bank would otherwise reach `undefined`
  // and take the show down on the next line.
  const name = ranked.length ? ranked[0][0] : Object.keys(bank)[0];

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
 * How many colours this track's look should hold, 2 | 3 | 4.
 *
 * The operator can still pick, and an explicit choice always wins. Asked to
 * decide, the rule is the one a designer would use: **a palette needs as many
 * colours as the show has passages to tell apart, and no more.** Four colours
 * on a track with two ideas does not read as richer, it reads as arbitrary —
 * the eye cannot attach a colour to a meaning if the colour keeps changing for
 * reasons the music does not support.
 *
 * `identities` is that count: distinct section looks after repeats have been
 * folded together, so a verse/chorus/verse/chorus track counts two, not four.
 *
 * Two measurements then say how much colour the music itself can carry. A track
 * with a clear tonal centre (`keyStrength`) and a wide image supports more
 * separation; a narrow, timbrally uniform one wants fewer, stronger colours —
 * which is also why minimal techno looks right in two and disco looks right in
 * four without either being a rule about genre.
 */
function paletteSizeFor({ score = null, identities = 0, mood = {} } = {}) {
  const wanted = Math.max(2, Math.min(4, identities || 2));
  const support = 0.45 * unit(score && score.keyStrength, 0.5)
    + 0.3 * unit(score && score.width, 0.5)
    + 0.25 * unit(mood.valence, 0.5);
  // Only ever pulls the count *down*, and only by one. The structure is the
  // measurement that knows what the show needs; this is the one that knows
  // whether the music can hold it.
  const size = support < 0.38 ? wanted - 1 : wanted;
  return Math.max(2, Math.min(4, size));
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
 * Pick a pattern for a passage, from what is *playing* in it.
 *
 * `character` is a `score.span()` reading — the mean level of each instrument
 * role across the passage, plus energy, pulse and texture. That is the change
 * from picking on a percentile level string: "high" said how loud the passage
 * was relative to the rest of the track and nothing about what was in it, so a
 * sung chorus and an instrumental drop at the same level got the same pools.
 * Whether the voice or the kick is carrying a passage is the thing that should
 * decide where the light goes, and the stems answer it directly.
 *
 * `rainbow` is deliberately absent from every pool: it generates its own hues
 * and ignores the colour slots, which would break the track's locked palette.
 */
function pickPattern({ character, available, score = null, seed = 0, drive = 0.5,
  dance = 0.5 }) {
  const c = character || {};
  const low = unit(c.kick) * 0.6 + unit(c.bassline) * 0.4;
  const voice = unit(c.vocal);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const energy = unit(c.energy, 0.4);
  const pulse = unit(c.pulse, 0.4);

  const genrePool = new Set([...blend(score ? score.subgenre : {}, SUBGENRE_PATTERNS).keys()]);
  const trust = unit(score && score.genreTrust);

  const pickFrom = (pool) => {
    let filtered = pool.filter((p) => available.has(p));
    // The genre bias is a preference, not a filter: it only applies when the
    // classifier earned some trust and when it leaves something to pick from.
    if (trust >= 0.25 && genrePool.size) {
      const biased = filtered.filter((p) => genrePool.has(p));
      if (biased.length) filtered = biased;
    }
    // Danceability decides between locking to the pulse and floating over it.
    // The expressive patterns are exempt: they follow the music at frame rate
    // and so are neither.
    if (dance >= 0.55) {
      const rhythmic = filtered.filter((p) => !FLOWY.has(p));
      if (rhythmic.length) filtered = rhythmic;
    } else if (dance <= 0.3) {
      const flowy = filtered.filter((p) => !RHYTHMIC.has(p));
      if (flowy.length) filtered = flowy;
    }
    if (!filtered.length) {
      return available.has('ribbon') ? 'ribbon'
        : available.has('chase') ? 'chase' : [...available][0];
    }
    return filtered[Math.abs(Math.round(seed)) % filtered.length];
  };

  // Quiet: nothing is carrying the passage, so nothing should be chasing.
  if (energy < 0.25 || drive < 0.22) {
    return pickFrom(['ribbon', 'fade', 'solid', 'wave', 'twinkle']);
  }

  // Vocal-led. The voice is the thing the audience is following, and light that
  // travels across the rig competes with it. `ensemble` exists for this case:
  // it holds the centre for the voice and puts the low end at the edges.
  //
  // But "vocal-led" is not the same as "quiet", and treating it as such was how
  // most of a party track ended up on a wash: a sung chorus over a four-to-the-
  // floor kick trips this test just as a ballad does. So the wash is kept for
  // the passages that are genuinely both, and a driving one gets patterns that
  // still move without reaching for the strobe end of the vocabulary.
  if (voice > low + 0.12) {
    return pickFrom(drive >= 0.5 || energy >= 0.5
      ? ['pairs', 'sections', 'ensemble', 'split', 'ping-pong', 'runner', 'chase']
      : ['ensemble', 'ribbon', 'wave', 'fade', 'twinkle', 'solid']);
  }

  // Low-end-led with a pulse to lock to: the passage has a groove and the rig
  // should be in it.
  if (low >= 0.4 && pulse >= 0.5) {
    const hard = drive >= 0.75 && (energy > 0.7 || pulse > 0.75);
    return pickFrom(hard
      ? ['hit', 'stack-up', 'sections', 'pairs', 'split', 'random-flash', 'ensemble']
      : ['pairs', 'sections', 'ensemble', 'runner', 'split', 'chase', 'stack-up']);
  }

  // Top-heavy: shimmer rather than punch.
  if (air > 0.45 && air > low) {
    return pickFrom(['sparkle', 'twinkle', 'ensemble', 'ribbon', 'wave', 'random-flash']);
  }

  // Everything else: moving, but not committed to the beat. The travelling
  // patterns lead the pool rather than the expressive ones, because this branch
  // is where most of a mid-energy track lands and a rig with no moving heads
  // needs the movement to come from somewhere.
  return pickFrom(['chase', 'runner', 'ping-pong', 'pairs', 'ensemble', 'ribbon', 'wave']);
}

/**
 * Which of the fixture's six strobe curves suits a passage.
 *
 * Texture, not intensity: the same strobe speed reads completely differently as
 * a stutter, a ramp or a random, and picking by what the low end is *doing*
 * rather than by how loud it is is what stops every energetic passage looking
 * like every other one. `score.articulation` is the measurement — a percussive,
 * fast-attacking bottom end against a slow, sustained one.
 */
function strobeFunctionFor(character, score) {
  const c = character || {};
  const articulation = unit(score && score.articulation, 0.5);
  const air = unit(c.texture);
  const low = unit(c.kick) * 0.6 + unit(c.bassline) * 0.4;

  if (articulation > 0.62 && low > 0.5) return air > 0.55 ? 'random' : 'ramp-down-rnd';
  if (air > 0.6) return 'random';
  if (low > 0.5) return 'ramp-up';
  if (articulation < 0.35) return 'ramp-down';
  return 'standard';
}

/**
 * Strobe speed on the pattern's own channel, 0 for "no strobe".
 *
 * Gated on the same articulation reading: a sustained, unpercussive passage at
 * high energy is a wall of sound, and strobing over it reads as a blur rather
 * than as excitement.
 */
function strobeSpeedFor(character, score, drive) {
  const c = character || {};
  const energy = unit(c.energy);
  const articulation = unit(score && score.articulation, 0.5);
  if (drive < 0.5 || energy < 0.45 || articulation < 0.35) return 0;
  const air = unit(c.texture);
  return Math.round(Math.min(255, 80 + energy * 130 + air * 45) * Math.min(1.2, drive));
}

/**
 * Which burst a moment deserves.
 *
 * The rig has six ways to punctuate and they are not interchangeable, so the
 * choice is made from what the music is doing rather than from how confident
 * the analyser was:
 *
 *   blinder       everything at full. The largest gesture the rig has, and it
 *                 belongs to a moment the track itself declares — a big,
 *                 uncompressed, triumphant arrival.
 *   white-strobe  cold and hard. Wants brightness in the music to match.
 *   color-strobe  the default loud accent, in the look's own colour.
 *   uv-wash       everything to blacklight. Reads as a change of state rather
 *                 than as a hit, which is what dark, aggressive music wants
 *                 from a rig that cannot move.
 *   kill          a hole in the light on the beat. This is what marks a
 *                 percussive transient: it is exactly as long as the hit, it
 *                 cannot smear the way a strobe spread over a kick does, and
 *                 it cannot be mistaken for the pattern underneath it.
 *   glow          a soft lift. The accent a calm track can have — before this
 *                 existed, every burst was too loud for a ballad and so a
 *                 ballad simply got none.
 *
 * The two dark gestures are what a `color-punch` used to try to be. A stab in
 * the look's own colour has no form that works on a rig of static pars: in the
 * palette's colour it reads as the pattern stuttering, and lifted with white it
 * reads as a weak blinder. Taking the light away has neither problem.
 */
function burstFor({ moment = 'accent', character, score, drive,
  headroom = true, vocal = false }) {
  const c = character || {};
  const semantic = (score && score.semantic) || {};
  const energy = unit(c.energy);
  const air = unit(c.texture) * 0.6 + unit(c.hats) * 0.4;
  const articulation = unit(score && score.articulation, 0.5);
  const triumphant = Math.max(unit(semantic.triumphant), unit(semantic.euphoric));
  const aggressive = Math.max(unit(semantic.aggressive), unit(semantic.dark));

  // A drop is the moment the whole budget exists to protect, so it is the only
  // moment allowed to reach the top of the vocabulary. Keeping the blinder and
  // the white strobe here — rather than letting a confident bar accent reach
  // them — is what stops them meaning nothing by the second chorus.
  if (moment === 'drop') {
    if (drive < 0.45 || energy < 0.3) return 'glow';
    if (drive < 0.72) return 'color-strobe';
    // Cold and hard for bright, aggressive arrivals; everything at full for a
    // triumphant one. With no mood words to go on, a drop this confident is
    // treated as an arrival, which is what a drop usually is.
    const cold = (air > 0.5 || aggressive > 0.55) && triumphant <= aggressive;
    return cold ? 'white-strobe' : 'blinder';
  }

  if (drive < 0.32 || energy < 0.3) return 'glow';
  // A voice is being sung over. Strobing across it is the single most common
  // way an automatic show announces that it is automatic. A hole in the light
  // is the one punctuation a sung phrase can carry, and only where the passage
  // is driving hard enough that the rig dropping out reads as deliberate.
  if (vocal) return drive >= 0.75 && energy > 0.65 ? 'kill' : 'glow';
  // A percussive low end wants its transient marked, not smeared: a strobe
  // spread over a kick is longer than the kick.
  if (articulation >= 0.5) return 'kill';
  // Dark and aggressive. Blacklight is the gesture that suits it — the rig
  // changes state rather than flashing, and on a UV-capable par it is the one
  // colour nothing else in the show can produce.
  if (aggressive > 0.55 && drive >= 0.5) return 'uv-wash';
  // Everything else is a ladder by how hard the passage is driving, and the
  // hole sits in the middle of it. That is the rung that used to be missing:
  // below the strobe there was only a soft lift, so a compressed master or a
  // mid-energy passage — which is most of a party playlist — got an accent you
  // had to be looking for.
  //
  // A brickwalled master never reaches the top rung, because a strobe over a
  // wall of sound has nothing to contrast against. Taking light away does not
  // have that problem: there is always contrast against light that is on.
  if (!headroom) return drive >= 0.55 ? 'kill' : 'glow';
  if (drive < 0.45) return 'glow';
  if (drive < 0.6) return 'kill';
  return 'color-strobe';
}

module.exports = {
  SUBGENRE_DRIVE, SUBGENRE_PALETTES, SUBGENRE_PATTERNS, SEMANTIC_PALETTES,
  CIRCUMPLEX_TETRADS, TIER_FLOOR, RHYTHMIC, FLOWY, EXPRESSIVE,
  driveFor, tierOf, buildPalette, paletteSizeFor, goldenStep, pickPattern, keyIndexOf,
  strobeFunctionFor, strobeSpeedFor, burstFor,
};
