// Importing the effect entry point registers every kind in each rendering host.
import './registry.ts';
import './hd.ts';
import './disco.ts';
import './ldj-channel.ts';
import './ldj-iteration.ts';
import './ldj-rotation.ts';
import './ldj-wave.ts';
import './ldj-matrix.ts';
import './ldj-studio.ts';
import './ldj-bitmap.ts';
import './ldj-visualizer.ts';
import './energy.ts';
import './strobe.ts';
import './macro.ts';
// The catalogue comes last: building it validates specs of every kind above.
export { BUILTIN_PALETTES, CATALOGUE, FAMILIES, LDJ_PRESETS, deepFreeze, presetById, presetIndex } from './catalogue.ts';
export type { CatalogueFamily, CataloguePreset } from './catalogue.ts';
export { LDJ_IDS } from './ldj-ids.ts';
export type { LdjClass, LdjEngine } from './ldj-ids.ts';
