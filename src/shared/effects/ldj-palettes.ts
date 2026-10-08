// The 26 palettes Light DJ seeds on first start, in its order. One table for
// the Visualizer's automatic colours and the catalogue's built-ins, so the two
// can never drift. Browser-safe static data; nothing here is mutable.

import type { PaletteEntry } from './types.ts';
import type { GradientSettings } from '../palette-model.ts';

export interface BuiltinPalette extends GradientSettings { id: string; name?: string; app: 'ldj' | 'hd' | 'look'; colours: readonly PaletteEntry[] }

const RANDOM = Object.freeze({ random: true as const });

// The app builds its named hues from degrees and its themed palettes from
// decimal hue/saturation/brightness truncated to whole units; the hex below is
// the result of that construction through Light DJ's colour conversion.
const rows: [string, PaletteEntry[]][] = [
  ['redCyan', ['#FF0000', '#00BFFF']],
  ['orangeBlue', ['#FF9900', '#2A00FF']],
  ['yellowPurple', ['#FFFF00', '#AA00FF']],
  ['greenPink', ['#00FF00', '#FF0095']],
  ['redYellow', ['#FF0000', '#FFFF00']],
  ['greenBlue', ['#00FF00', '#2A00FF']],
  ['whiteOff', ['#FFFFFF', '#000000']],
  ['randomRandom', [RANDOM, RANDOM]],
  ['redOrangeYellow', ['#FF0000', '#FF9900', '#FFFF00']],
  ['orangeYellowGreen', ['#FF9900', '#FFFF00', '#00FF00']],
  ['yellowGreenCyan', ['#FFFF00', '#00FF00', '#00BFFF']],
  ['greenCyanBlue', ['#00FF00', '#00BFFF', '#2A00FF']],
  ['cyanBluePurple', ['#00BFFF', '#2A00FF', '#AA00FF']],
  ['bluePurplePink', ['#2A00FF', '#AA00FF', '#FF0095']],
  ['purplePinkRed', ['#AA00FF', '#FF0095', '#FF0000']],
  ['pinkRedOrange', ['#FF0095', '#FF0000', '#FF9900']],
  ['redYellowBlue', ['#FF0000', '#FFFF00', '#2A00FF']],
  ['yellowPurplePink', ['#FFFF00', '#AA00FF', '#FF0095']],
  ['greenCyanPink', ['#00FF00', '#00BFFF', '#FF0095']],
  ['rocketPop', ['#D60210', '#F0F1FF', '#0814FF']],
  ['blueDream', ['#0B1066', '#0A108C', '#0E4EAD', '#0E7BC9']],
  ['strawberryDaiquiri', ['#8A0700', '#F75C78', '#F53659', '#F20A34']],
  ['screwdriver', ['#FC530A', '#FFA929', '#F7822F', '#FC6F0A']],
  ['goodVibes', ['#226987', '#FFF203', '#FFA600', '#3890B5']],
  ['electricSummer', ['#00DBBE', '#BEF711', '#F1FF33', '#FC235A']],
  ['rainbow', ['#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00BFFF', '#2A00FF', '#AA00FF', '#FF0095']],
];

/** Northern Lights is defined in the app but never seeded, so it is not here. */
export const LDJ_PALETTES: readonly BuiltinPalette[] = Object.freeze(rows.map(([id, colours]) =>
  Object.freeze({ id, app: 'ldj' as const, colours: Object.freeze(colours) })));
