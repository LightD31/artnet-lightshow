/**
 * A Philips Hue lamp's profile, built from what its bridge says it can show.
 *
 * A Hue lamp is patched from the bridge as a WLED is (routes/fixtures.ts):
 * one fixture per lamp of the entertainment area, on a profile of its own that
 * describes that lamp rather than a generic bulb. What goes into it is what
 * the bridge reported (hue.ts):
 *
 *   - Every lamp dims, so every section has a dimmer.
 *   - A lamp with a colour gamut mixes colour: red, green and blue.
 *   - A lamp that tunes white gets a warm and a cool white, named for the
 *     warmest and coolest white it can show. The show's colours carry most
 *     of their white in their white and amber components — "Cool White" is
 *     r0 g30 b80 with white at full — so without these a white look reaches
 *     a Hue lamp as a dim blue. They fold back into the colour sent at the
 *     lamp's own temperatures (output.ts).
 *   - A colour lamp also takes UV, shown as a deep violet. No Hue lamp emits
 *     UV, but without somewhere to land a UV wash leaves every Hue lamp black
 *     for its length while the pars glow, which reads as a dead lamp.
 *   - No strobe: the bridge interpolates between the frames it is sent, so a
 *     strobe value would be discarded on arrival.
 *
 * A lamp of several sections — a gradient strip, a Play gradient — is one
 * fixture with a cell for each, in order along it, each cell on its own
 * entertainment channel. Each section has its own dimmer rather than one for
 * the lamp, so a section's channels alone say what it shows.
 *
 * The profile carries the lamp's traits as `hue`, which is how anything
 * reading it knows it is a Hue lamp's (shared/hue-lamp.ts).
 */

import { profileSchema, validate } from './validation.ts';
import type { ProfileInput } from './validation.ts';
import type { AreaLamp } from './hue.ts';
import type { ChannelListEntry, ChannelMap, HueLampTraits, ProfileCell } from '../types/rig.ts';

/** A lamp's profile id, from its entertainment service: one profile per lamp. */
function hueProfileId(lampId: string): string {
  return `hue-${lampId}`.slice(0, 128);
}

/** What a lamp can show, as a profile carries it; null when the bridge would not say. */
function traitsOf(lamp: Pick<AreaLamp, 'capabilities'>): HueLampTraits | null {
  const caps = lamp.capabilities;
  if (!caps) return null;
  const fixed = caps.fixedWhite !== null ? { warm: caps.fixedWhite, cool: caps.fixedWhite } : null;
  return { gamut: caps.gamut, whites: caps.whites || fixed };
}

/** A temperature as a person reads it: to the nearest hundred kelvin. */
function kelvinLabel(kelvin: number): string {
  return `${Math.round(kelvin / 100) * 100} K`;
}

/** What a lamp shows, in a few words, for the profile's mode name. */
function describe(traits: HueLampTraits, sections: number): string {
  const parts: string[] = [];
  if (sections > 1) parts.push(`${sections} sections`);
  if (traits.gamut) parts.push(traits.gamut === 'other' ? 'colour' : `colour (gamut ${traits.gamut})`);
  const { whites } = traits;
  if (whites && whites.warm !== whites.cool) parts.push(`white ${kelvinLabel(whites.warm)}–${kelvinLabel(whites.cool)}`);
  else if (whites) parts.push(`white ${kelvinLabel(whites.warm)}`);
  else if (!traits.gamut) parts.push('white');
  return parts.join(', ');
}

/** One section's channels, from `start`: [attribute, name] in order. */
function sectionChannels(traits: HueLampTraits): [string, string][] {
  const out: [string, string][] = [['dimmer', 'Dimmer']];
  if (traits.gamut) out.push(['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']);
  const { whites } = traits;
  if (whites && whites.warm !== whites.cool) {
    out.push(['warmWhite', `White ${kelvinLabel(whites.warm)}`], ['coolWhite', `White ${kelvinLabel(whites.cool)}`]);
  }
  if (traits.gamut) out.push(['uv', 'UV (shown as violet)']);
  return out;
}

/**
 * The profile for one lamp of the area, or null when the bridge would not say
 * what it can show.
 */
function hueProfile(lamp: AreaLamp): ProfileInput | null {
  const traits = traitsOf(lamp);
  if (!traits || !lamp.channels.length) return null;
  const section = sectionChannels(traits);
  const sections = lamp.channels.length;
  const channelList: ChannelListEntry[] = [];
  const channelMap: ChannelMap = {};
  const cells: ProfileCell[] = [];
  for (let c = 0; c < sections; c++) {
    const map: ChannelMap = {};
    section.forEach(([attribute, name], k) => {
      const offset = c * section.length + k;
      map[attribute] = offset;
      channelList.push(sections > 1 ? { offset, name: `Section ${c + 1} ${name}`, attribute, cell: c } : { offset, name, attribute });
    });
    if (sections > 1) cells.push({ name: `Section ${c + 1}`, channelMap: map });
    else Object.assign(channelMap, map);
  }
  return validate(profileSchema, {
    id: hueProfileId(lamp.id),
    // The product as the bridge names it ("Hue gradient lightstrip"), which
    // says whose it is already: no manufacturer in front of it.
    name: (lamp.product || 'Hue lamp').slice(0, 128),
    modeName: describe(traits, sections).slice(0, 128),
    channelCount: sections * section.length,
    channelMap,
    channelList,
    ...(cells.length ? { cells } : {}),
    hue: traits,
  }, 'Hue lamp profile');
}

export { hueProfile, hueProfileId, traitsOf };
