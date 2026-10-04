/**
 * Philips Hue lamps, as the server and the page both need them.
 *
 * A Hue lamp's profile is built from what its bridge says the lamp can show
 * (server/hue-profile.ts) and carries that as `hue`; no other profile does. So
 * the profile alone says whether a fixture is a Hue lamp, wherever it is read.
 *
 * Browser-safe.
 */

import type { HueLampTraits } from '../types/rig.ts';

/** Whether a profile is a Hue lamp's. */
function isHueProfile(profile: { hue?: unknown } | null | undefined): profile is { hue: HueLampTraits } {
  return !!profile && !!profile.hue && typeof profile.hue === 'object';
}

/** How many entertainment channels a Hue lamp on this profile takes: one a section. */
function hueSections(profile: { cells?: readonly unknown[] }): number {
  return profile.cells ? profile.cells.length : 1;
}

/** A lamp's entertainment channels, as a person reads them: "channel #3", "channels #3–#9". */
function hueChannelsLabel(channels: readonly number[]): string {
  if (channels.length === 1) return `channel #${channels[0]}`;
  const run = channels.every((ch, k) => k === 0 || ch === channels[k - 1] + 1);
  return run ? `channels #${channels[0]}–#${channels[channels.length - 1]}` : `channels ${channels.map((ch) => `#${ch}`).join(', ')}`;
}

/**
 * The colour of a white light at `kelvin`, each component 0–1 of the
 * brightest: Tanner Helland's fit to the blackbody curve, good to a few
 * percent from 1000 K to 40000 K. 2700 K comes out (1, 0.65, 0.34), the
 * tungsten white that still has real blue in it; 6500 K very nearly neutral.
 */
function kelvinColour(kelvin: number): { r: number; g: number; b: number } {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  const out = { r: clamp(r), g: clamp(g), b: clamp(b) };
  const peak = Math.max(out.r, out.g, out.b) || 1;
  return { r: out.r / peak, g: out.g / peak, b: out.b / peak };
}

export { isHueProfile, hueSections, hueChannelsLabel, kelvinColour };
