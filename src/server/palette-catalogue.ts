import { BUILTIN_PALETTES } from '../shared/effects/index.ts';
import { toHex } from '../shared/palette-model.ts';
import { COLOR_PRESETS } from './presets.ts';
import { PALETTES } from './palettes.ts';
import type { BuiltinPalette } from '../shared/effects/ldj-palettes.ts';

export const ALL_PALETTES: readonly BuiltinPalette[] = Object.freeze([
  ...BUILTIN_PALETTES,
  ...PALETTES.map((p) => ({ id: p.id, name: p.name, app: 'look' as const,
    colours: p.colors[4].map((i) => toHex(COLOR_PRESETS[i])) })),
]);
