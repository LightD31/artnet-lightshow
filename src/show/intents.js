'use strict';

/**
 * Lighting intents — what the show wants to happen, in rig-neutral terms.
 *
 *     musical events  ->  LIGHTING INTENT  ->  DMX / Art-Net
 *
 * An intent says "hold this look", "hit a colour strobe for 300 ms", "move the
 * beat clock to 140". It says nothing about DMX channels, patch fields or
 * fixture personalities — that translation is `render.js`, and keeping it
 * separate is what lets the director be tested by reading its decisions rather
 * than by decoding a stream of channel values.
 *
 * `priority` breaks ties when two intents want the same instant. It also drives
 * the contrast pass: when the show is over budget, the lowest-priority accents
 * are the ones that go.
 */

const INTENT = Object.freeze({
  /** Establish a whole look: pattern, colours, beat division, strobe channel. */
  SCENE: 'SCENE',
  /** Move colours only, leaving the pattern and everything else alone. */
  COLOR: 'COLOR',
  /** A short burst on top of the current look. */
  ACCENT: 'ACCENT',
  /** Move the beat clock. */
  TEMPO: 'TEMPO',
  /** Go dark — the gap before a drop, or a genuine silence in the track. */
  DARK: 'DARK',
});

/** Burst kinds, loudest first. The renderer maps these to energy overrides. */
const BURST = Object.freeze({
  BLINDER: 'blinder',
  WHITE_STROBE: 'white-strobe',
  COLOR_STROBE: 'color-strobe',
});

const PRIORITY = Object.freeze({
  DROP: 100,
  BUILDUP: 80,
  SECTION: 60,
  TEMPO: 55,
  SILENCE: 50,
  ROTATION: 40,
  MELODY: 30,
  BAR_ACCENT: 20,
  BEAT_ACCENT: 10,
});

function scene(timeMs, payload, { source = 'section', priority = PRIORITY.SECTION } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.SCENE, source, priority, ...payload };
}

function color(timeMs, colors, { source = 'melody', priority = PRIORITY.MELODY } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.COLOR, source, priority, colors };
}

function accent(timeMs, burst, durationMs,
  { source = 'bar', priority = PRIORITY.BAR_ACCENT, confidence = 1 } = {}) {
  return {
    timeMs: Math.round(timeMs), kind: INTENT.ACCENT, source, priority,
    burst, durationMs: Math.round(durationMs), confidence,
  };
}

function tempo(timeMs, bpm, { source = 'curve', priority = PRIORITY.TEMPO } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.TEMPO, source, priority, bpm };
}

/**
 * `colorIndex` left unset means "whatever the rig calls off" — the renderer
 * fills it in. Passing one is for the rare case where a particular dark colour
 * is wanted rather than the configured blackout.
 */
function dark(timeMs, { source = 'gap', priority = PRIORITY.SILENCE,
  colorIndex = null } = {}) {
  return { timeMs: Math.round(timeMs), kind: INTENT.DARK, source, priority, colorIndex };
}

module.exports = { INTENT, BURST, PRIORITY, scene, color, accent, tempo, dark };
