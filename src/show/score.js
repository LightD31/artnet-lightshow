'use strict';

/**
 * What the music is doing, at any instant.
 *
 * The analyser produces two kinds of thing. Most of it is *episodic* — a drop
 * at 94.2 s, a section from 32 to 64, a beat grid — and the director reads that
 * directly. The rest is *continuous*: stem envelopes, band curves, a loudness
 * profile, timbre embeddings every two seconds. This module is the reader for
 * the continuous half, and the reason it exists is that every consumer of it
 * needs the same three things and none of them should re-derive them:
 *
 *   A reading at a time.      `sample(t)` — what is playing right now.
 *   A character for a span.   How percussive, how wide, how loud it can get.
 *   An identity for a span.   Is this passage the same as that earlier one.
 *
 * Nothing here decides anything. It measures, normalises and reports how much
 * it trusts its own answer, and the director does the deciding — which is what
 * keeps "the rig strobes here" traceable to a number rather than to a chain of
 * thresholds spread over three files.
 *
 * **Every input is optional.** A document from an older analyser, or from a rig
 * without the separation model, is missing whole sections of this. Each reading
 * falls back to a coarser measurement of the same thing and says so through
 * `confidence`, because a show that refuses to plan is worse than a show
 * planned from the mix alone.
 */

const unit = (v, fallback = 0) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
const list = (v) => (Array.isArray(v) ? v : []);
const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const mean = (values) => (values.length
  ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

/**
 * A reader over a `[{t, v}]` curve, linearly interpolated.
 *
 * The curves arrive on a half-second grid and the director samples them on its
 * own grid, so reading the nearest point would quantise every envelope to the
 * analyser's hop. Interpolating instead is what lets the expression channel
 * follow a swell rather than step up it.
 */
function curve(raw, fallback = 0) {
  const points = list(raw)
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  return (t) => {
    if (!points.length) return fallback;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (points[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const a = points[lo];
    const b = points[lo + 1];
    if (!b || t <= a.t) return a.v;
    return a.v + (b.v - a.v) * unit((t - a.t) / Math.max(0.001, b.t - a.t));
  };
}

// How wide a spread across the mood vocabulary counts as a track having said
// something definite. Measured rather than picked: a real MuQ-MuLan pass over
// the twelve words spans about a third of a cosine, so 0.2 is comfortably
// inside what music actually produces and well outside what noise does.
const SEMANTIC_FULL_SPREAD = 0.2;

/**
 * MuQ-MuLan's mood words, rescaled to 0..1 across the words it was asked about.
 *
 * The raw numbers are cosine similarities in a joint space. Their *absolute*
 * value means nothing usable — every word on every track scores somewhere
 * around 0.2 — and only the spread between them carries information, so the set
 * is min-max normalised.
 *
 * Normalising alone is not enough, and the failure is worth naming because it
 * is the kind that looks like evidence. Min-max over three words half a percent
 * apart returns a confident 1.0 for the top one: the *ordering* is real, but
 * scaling it to full strength manufactures a certainty the model never
 * expressed, and a palette chosen from it beats a genuinely confident genre.
 * So the whole set is attenuated by how wide the raw spread was, and a set with
 * no spread at all returns nothing rather than an arbitrary winner. A track
 * that is equally "warm" and "cold" has told us it is neither.
 */
function semantics(raw) {
  const entries = list(raw).filter((p) => p && typeof p.label === 'string'
    && Number.isFinite(p.score));
  if (!entries.length) return {};
  const scores = entries.map((p) => p.score);
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  const spread = high - low;
  if (spread < 0.025) return {};
  const strength = unit(spread / SEMANTIC_FULL_SPREAD);
  return Object.fromEntries(entries.map((p) =>
    [p.label, unit((p.score - low) / spread) * strength]));
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/**
 * The subgenre distribution, kept whole instead of collapsed to its winner.
 *
 * This is the reading that changed most when the genre classifier did. The
 * analyser now returns sixteen scores that are a real distribution — the show
 * only ever used `label`, which throws away the interesting case: when the
 * classifier *cannot* pick, its shape still says something true. A track split
 * between `jazz` and `folk` is not "unknown"; it is plainly acoustic, and it
 * should get an acoustic look. Winner-take-all could not express that, and fell
 * through to tempo and arousal — which is how a double-bass trio ends up lit
 * from its BPM.
 *
 * Weights are scaled by how much the label is worth trusting, so a confident
 * distribution pulls hard and a flat one barely moves anything.
 */
function subgenreWeights(genre) {
  const scores = genre && genre.subScores;
  if (!scores || typeof scores !== 'object') return { weights: {}, trust: 0 };
  const entries = Object.entries(scores).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!entries.length || total <= 0) return { weights: {}, trust: 0 };

  const weights = Object.fromEntries(entries.map(([k, v]) => [k, v / total]));
  const ranked = Object.values(weights).sort((a, b) => b - a);
  // How concentrated the distribution is, on its own terms: the top weight
  // against a uniform spread over the same number of buckets. This works
  // whether the scores came from MuQ-MuLan's softmax or from the AudioSet
  // fold's unnormalised sums, which is the point — the caller must not have to
  // know which classifier answered to know how much to believe it.
  const uniform = 1 / entries.length;
  const peak = unit((ranked[0] - uniform) / Math.max(0.001, 1 - uniform));
  const lead = ranked.length > 1 ? unit((ranked[0] - ranked[1]) / Math.max(0.001, ranked[0])) : 1;
  // A zero-shot music model is worth more here than a general-audio tagger
  // folded into musical categories; the fold is lossy in exactly these
  // categories. See `GENRE_PROMPTS` in the analyser for why.
  const source = genre.source === 'muq-mulan' ? 1 : genre.source === 'panns' ? 0.75 : 0.5;
  return { weights, trust: unit(peak * 0.6 + lead * 0.4) * source };
}

/**
 * Blend a per-subgenre table into one weighted score per entry.
 *
 * `table` maps a subgenre to the things it votes for; every vote is worth that
 * subgenre's share of the distribution. Used for tiers, palette banks and
 * pattern pools alike, so those three cannot drift apart in how they read the
 * same distribution.
 */
function blend(weights, table, value = () => 1) {
  const out = new Map();
  for (const [name, weight] of Object.entries(weights)) {
    const entry = table[name];
    if (entry == null) continue;
    for (const item of (Array.isArray(entry) ? entry : [entry])) {
      const key = Array.isArray(entry) ? item : entry;
      out.set(key, (out.get(key) || 0) + weight * value(item, name, entry));
    }
  }
  return out;
}

/**
 * Build the score for one analysis document.
 */
function makeScore(analysis) {
  const a = analysis || {};
  const bands = a.bands || {};
  const roles = a.instruments || {};
  const sources = a.sources || {};

  // ── Instrument envelopes ─────────────────────────────────────────────────
  //
  // Preferred: the separated stems, where "is there a voice here" is a question
  // about the vocals stem rather than about mid-band movement. Falling back to
  // a frequency band is a worse answer to the same question, not a different
  // one, so the fallback is per-role and silent.
  const ROLE_BAND = { kick: 'sub', snare: 'mid', hats: 'high', bassline: 'bass', vocal: 'mid', synth: 'presence' };
  const ROLE_SOURCE = { kick: 'drums', snare: 'drums', hats: 'drums', bassline: 'bass', vocal: 'vocals', synth: 'other' };
  const sourceMax = Math.max(0.001, ...Object.values(sources).filter(Number.isFinite));
  const separated = !!roles.curves;

  const envelopes = Object.fromEntries(Object.keys(ROLE_BAND).map((name) => {
    const band = bands[ROLE_BAND[name]];
    const read = curve((roles.curves && roles.curves[name]) || (band && band.curve));
    // How much of the rig's attention this role has earned. Without a role
    // score the band's own importance stands in, floored at a half so an
    // unmeasured role is quiet rather than absent.
    const strength = (roles.scores && roles.scores[name] != null)
      ? unit(roles.scores[name])
      : 0.5 + 0.5 * unit(band && band.importance, 0.5);
    // The stem's share of the mix. A vocals stem holding two percent of the
    // energy is separation leakage, not a singer, and lighting the centre for
    // it is the most visible way an automatic show gets a track wrong.
    const source = sources[ROLE_SOURCE[name]];
    const share = Number.isFinite(source) ? Math.sqrt(unit(source / sourceMax)) : 1;
    const gain = Math.sqrt(strength * share);
    return [name, (t) => unit(read(t)) * gain];
  }));

  // ── Level, impact, pulse ─────────────────────────────────────────────────
  const sectionEnergy = (t) => unit(list(a.segments)
    .find((p) => t >= p.start && t < p.end)?.energy, 0.4);
  const energy = list(a.energyCurve).length ? curve(a.energyCurve, 0.4) : sectionEnergy;
  const impact = curve(a.dynamics?.impactCurve);

  // Groove, for tracks with no beat-intensity curve: how much of the spectrum's
  // *important* content is rhythmic. Weighting by importance rather than
  // averaging the bands stops a busy but inaudible top octave from claiming a
  // ballad has a groove.
  const bandList = Object.values(bands).filter((b) => b && typeof b === 'object');
  const totalImportance = bandList.reduce((sum, b) => sum + unit(b.importance), 0);
  const groove = totalImportance
    ? bandList.reduce((sum, b) => sum + unit(b.importance) * unit(b.rhythmic), 0) / totalImportance
    : 0.5;
  const pulse = curve(a.rhythm?.intensityCurve, groove);

  // ── Fixed character ──────────────────────────────────────────────────────
  const noise = unit(a.features?.flatness?.mean);
  const crisp = unit(0.5 * finite(a.features?.centroid?.mean, 2200) / 6000
    + 0.5 * finite(a.features?.rolloff?.mean, 6000) / 12000);
  const grain = unit(0.5 * noise + 0.5 * unit(a.features?.zcr?.mean));

  // How *punchy* the low end is, which decides whether an accent should be a
  // stab or a strobe. Two independent readings of the same thing: the sub
  // band's percussive share, and how fast it attacks. 30 ms is a kick drum;
  // 200 ms is a synth bass swelling in, and flashing at it looks like a mistake.
  const attackMs = finite(bands.sub?.attackMs ?? bands.bass?.attackMs, 90);
  const articulation = unit(0.6 * unit(bands.sub?.percussive, 0.5)
    + 0.4 * unit((200 - attackMs) / 170));
  // How long the rig should hold a gesture before letting it fall. A dub bass
  // ringing for half a second and a muted funk bass want different releases,
  // and the band's own decay is the measurement of exactly that.
  const decay = unit(finite(bands.bass?.decayMs ?? bands.sub?.decayMs, 250) / 1000);

  // Dynamic range: how much contrast the track itself has to offer. A brickwall
  // master has none, and asking the expression channel to find some in it only
  // produces flicker.
  const range = unit(finite(a.loudness?.range, 8) / 16);
  // Loudness headroom — the gap between the true peak and the integrated level.
  // Small means compressed, and a compressed track needs the rig to supply the
  // dynamics the master no longer has.
  //
  // The two numbers do not come from the same signal, and subtracting them
  // directly is why this used to report almost every master as brickwalled.
  // `integratedLufs` is measured on the file as delivered; the analysis copy is
  // then normalised to a target, and `truePeakDb` is measured on *that*. The
  // difference between them therefore asks how loud the original was against
  // the peak of a rescaled copy, which is not a question about the music: over
  // a set of real tracks it returned crest factors between 0 and 4 dB, where
  // music does not go. Adding the applied gain back puts both on the normalised
  // signal, and the difference is the crest factor — around 10 dB for a
  // brickwalled pop master and 15 for one with its dynamics intact.
  //
  // The scale is set from that range rather than from full scale, because the
  // six decibels at the bottom of it are ones no released record occupies and
  // spending half the reading on them is what makes the rest of it unable to
  // tell two masters apart.
  const crestDb = finite(a.loudness?.truePeakDb, -1)
    - (finite(a.loudness?.integratedLufs, -12) + finite(a.loudness?.appliedGainDb, 0));
  const crest = unit((crestDb - 6) / 14);

  const width = unit(unit(a.stereo?.width, 0.5) * 0.8
    + (1 - finite(a.stereo?.correlation, 0)) * 0.1);

  // ── Trust ────────────────────────────────────────────────────────────────
  //
  // One number for "how much of this document is worth acting on", from the two
  // measurements that actually predict it: the recording's signal-to-noise, and
  // how sure the beat tracker was. A phone recording of a PA and a mastered
  // file are both analysable; only one of them should drive a strobe.
  const beatConfidence = list(a.rhythm?.beatConfidences).filter(Number.isFinite);
  const certainty = beatConfidence.length ? mean(beatConfidence) : 1;
  const snr = unit(finite(a.loudness?.snrDb, 40) / 30);
  const confidence = snr * (0.6 + 0.4 * unit(certainty));
  const stability = unit(a.rhythm?.stability ?? a.tempoStability, 0.8);
  const keyStrength = unit(a.keyStrength, 0.5);

  // ── Timbre ───────────────────────────────────────────────────────────────
  const embeddings = list(a.embeddings).filter((p) => p && Number.isFinite(p.time)
    && Array.isArray(p.vector) && p.vector.length && p.vector.every(Number.isFinite));
  const nearest = (t) => embeddings.reduce((best, p) => (!best
    || Math.abs(p.time - t) < Math.abs(best.time - t) ? p : best), null);

  const semantic = semantics(a.semantic_scores);
  const genre = subgenreWeights(a.genre);

  return {
    semantic,
    subgenre: genre.weights,
    genreTrust: genre.trust,
    separated,
    confidence: unit(confidence),
    stability,
    keyStrength,
    articulation,
    decay,
    width,
    range,
    crest,
    texture: unit(0.5 * grain + 0.5 * crisp),

    /** Everything that varies with time, read at `t`. */
    sample(t) {
      const r = Object.fromEntries(Object.entries(envelopes)
        .map(([key, read]) => [key, read(t)]));
      return {
        ...r,
        energy: unit(energy(t)),
        impact: unit(impact(t)),
        pulse: unit(pulse(t)),
        // What the top of the rig should be doing: hats measured, plus the
        // track's fixed grain and brightness for the tracks with no stems.
        texture: unit(0.45 * r.hats + 0.3 * grain + 0.25 * crisp),
        range,
      };
    },

    /** The mean reading across a span — the character of a whole section. */
    span(start, end, steps = 12) {
      const step = Math.max(0.25, (end - start) / steps);
      const rows = [];
      for (let t = start; t < end; t += step) rows.push(this.sample(t));
      if (!rows.length) rows.push(this.sample(start));
      return Object.fromEntries(Object.keys(rows[0])
        .map((key) => [key, mean(rows.map((r) => r[key]))]));
    },

    /** The mean timbre vector over a span, for identity matching. */
    vector(start, end) {
      const rows = embeddings.filter((p) => p.time >= start && p.time < end);
      if (!rows.length) return nearest((start + end) / 2)?.vector;
      const valid = rows.filter((p) => p.vector.length === rows[0].vector.length);
      return valid[0].vector.map((_, i) => mean(valid.map((p) => p.vector[i])));
    },

    /**
     * How different the timbre is from four seconds ago, 0..1.
     *
     * This is the one measurement in the document that notices a change the
     * envelopes cannot: a track that swaps its synth for a piano at the same
     * level, in the same band, with the same groove. Zero without embeddings,
     * so the director's rotation falls back to counting bars.
     */
    novelty(t) {
      if (embeddings.length < 2) return 0;
      return unit(1 - cosine(nearest(t)?.vector, nearest(Math.max(0, t - 4))?.vector));
    },
  };
}

/** Does this document carry any of the continuous data at all? */
function hasScore(a) {
  return !!(a && (a.instruments?.curves || a.bands
    || list(a.embeddings).length || list(a.semantic_scores).length));
}

module.exports = {
  makeScore, hasScore, semantics, subgenreWeights, blend, cosine, curve,
  SEMANTIC_FULL_SPREAD, unit, list, finite,
};
