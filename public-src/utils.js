import { channelReader } from '../src/shared/placement.ts';

// Approximate the visual mix on a screen for the rig's RGBWAUV channels.
// Amber adds warm orange (R + 0.5 G); UV reads as blue-violet (R 0.2 + B 0.9).
//
// Out-of-gamut sums are scaled back proportionally rather than clamped per
// channel. Clamping threw away exactly the difference that matters: any preset
// driving white hard pins all three channels at 255, so Warm White and Cool
// White — which differ only in temperature — came out as the same flat swatch
// and the operator could not tell the two buttons apart. Scaling keeps the hue
// and gives up only absolute brightness, which a swatch was never showing
// truthfully anyway.
export function colorToCss({ r, g, b, w = 0, a = 0, uv = 0 }) {
  let rr = r + w + a + uv * 0.2;
  let gg = g + w + a * 0.5;
  let bb = b + w + uv * 0.9;
  const peak = Math.max(rr, gg, bb);
  if (peak > 255) {
    const k = 255 / peak;
    rr *= k; gg *= k; bb *= k;
  }
  return `rgb(${Math.round(rr)},${Math.round(gg)},${Math.round(bb)})`;
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${Math.round(v * 100)}%`;
}

/** A tempo as a person reads it: whole when it is whole, else to a tenth. */
export function formatBpm(bpm) {
  const n = Number(bpm);
  if (bpm == null || !Number.isFinite(n)) return '—';
  const tenth = Math.round(n * 10) / 10;
  return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
}

// What the pattern clock is keeping time by (server/conductor.js), as the
// tempo block names it.
const CLOCK_SOURCES = {
  auto: { label: 'Auto', locked: true, title: 'Patterns step on the auto show\'s analysed beats' },
  cdj: { label: 'CDJ', locked: true, title: 'Patterns step on the playing deck\'s beats (PRO DJ LINK)' },
  live: { label: 'LIVE', locked: true, title: 'Patterns step on the beats heard in the live audio' },
  track: { label: 'Track', locked: true, title: 'Patterns step on the playing song\'s analysed beats. Tap or set a BPM to take over until the next song' },
  tap: { label: 'Tap', locked: false, title: 'Patterns run free at this BPM: tap tempo, the ± buttons or MIDI set it' },
};

export function clockSource(id) {
  const key = Object.hasOwn(CLOCK_SOURCES, id) ? id : 'tap';
  return { id: key, ...CLOCK_SOURCES[key] };
}

export function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

// An LED bar's profile lists its cells, each with its own channels (see
// src/shared/rig.js). Read here without importing it: this module is loaded on
// its own by the tests, so it stays free of imports.
const cellsOfProfile = (profile) => (profile && Array.isArray(profile.cells) && profile.cells.length >= 2
  ? profile.cells : null);

/** A pinned fixture's colour, through the grand master and its own trim. */
function overrideLight(fix, state) {
  const ov = fix.override;
  const dim = (ov.dim !== undefined ? ov.dim : 255) / 255;
  // The same two scalers the engine applies: the grand master and the
  // fixture's own trim.
  const mDim = (state.masterDimmer / 255) * ((fix.maxBrightness ?? 255) / 255);
  return {
    r:  Math.round(ov.r  * dim * mDim),
    g:  Math.round(ov.g  * dim * mDim),
    b:  Math.round(ov.b  * dim * mDim),
    w:  Math.round(ov.w  * dim * mDim),
    a:  Math.round((ov.a  || 0) * dim * mDim),
    uv: Math.round((ov.uv || 0) * dim * mDim),
  };
}

/**
 * A fixture's channels in the snapshot, through its placement: a strip that
 * runs on over several universes reads each cell from the one it is on.
 */
function fixtureReader(fix, profile, all) {
  return channelReader(fix.universe ?? 0, fix.address, profile, (u) => all[u]);
}

/** One light's emitters, read through its channel map. */
function readLight(at, ch, scale) {
  const k = scale * (ch.dimmer !== undefined ? at(ch.dimmer) / 255 : 1);
  return {
    r:  Math.round(at(ch.red)   * k),
    g:  Math.round(at(ch.green) * k),
    b:  Math.round(at(ch.blue)  * k),
    w:  Math.round(at(ch.white) * k),
    a:  Math.round(at(ch.amber) * k),
    uv: Math.round(at(ch.uv)    * k),
  };
}

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

/**
 * What each cell of an LED bar is showing, as emitter values, or null for a
 * fixture that is one light. The bar's own dimmer scales every cell.
 */
export function fixtureCellLights(fix, state, dmxSnapshot) {
  if (!fix) return null;
  const profile = state.profiles && state.profiles[fix.profileId];
  const cells = cellsOfProfile(profile);
  if (!cells) return null;
  if (state.masterBlackout) return cells.map(() => BLACK);
  if (fix.override && fix.override.enabled) {
    const light = fix.override.blackout ? BLACK : overrideLight(fix, state);
    return cells.map(() => light);
  }
  const at = fixtureReader(fix, profile, dmxSnapshot || state.dmxSnapshot || {});
  const ch = profile.channelMap || {};
  const barDim = ch.dimmer !== undefined ? at(ch.dimmer) / 255 : 1;
  return cells.map((cell) => readLight(at, cell.channelMap || {}, barDim));
}

/** Each cell of a bar as a CSS colour, or null for a fixture that is one light. */
export function fixtureCellColors(fix, state, dmxSnapshot) {
  const lights = fixtureCellLights(fix, state, dmxSnapshot);
  return lights ? lights.map(colorToCss) : null;
}

/** The mean of several lights: a bar's overall glow, in one swatch. */
export function meanLight(lights) {
  const sum = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };
  for (const light of lights) for (const key of Object.keys(sum)) sum[key] += light[key] || 0;
  const n = Math.max(1, lights.length);
  for (const key of Object.keys(sum)) sum[key] = Math.round(sum[key] / n);
  return sum;
}

export function fixtureOutputColor(fix, state, dmxSnapshot) {
  if (!fix) return '#000';
  if (state.masterBlackout) return '#000';

  if (fix.override && fix.override.enabled) {
    if (fix.override.blackout) return '#000';
    return colorToCss(overrideLight(fix, state));
  }

  // A bar is many colours at once; its swatch is their mean.
  const cells = fixtureCellLights(fix, state, dmxSnapshot);
  if (cells) return colorToCss(meanLight(cells));

  // Read DMX snapshot through the fixture's profile channel map. The snapshot
  // is keyed by universe, so pick out the one this fixture lives on.
  const profile = state.profiles && state.profiles[fix.profileId];
  if (!profile || !profile.channelMap) return '#111';
  const at = fixtureReader(fix, profile, dmxSnapshot || state.dmxSnapshot || {});
  return colorToCss(readLight(at, profile.channelMap, 1));
}
