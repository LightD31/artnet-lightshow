/**
 * What there is to choose from: patterns, colours, palettes, energy effects,
 * strobe functions, the rig's fixtures and its cues.
 *
 * The server sends its own catalogues with the first snapshot, so a pattern or
 * a palette added to the server shows up in Companion without a new module.
 * The lists below are only what the module offers before it has connected.
 * They mirror src/server/presets.ts, where colours are sent as indices into
 * the preset table, so order matters.
 *
 * No Companion imports: the module's tests run it on its own.
 */

export const COLOR_PRESETS = [
	// Saturated wheel — one entry per recognisable hue, none within 30° of
	// another. The angle is the mixed hue, not the r/g/b triple.
	{ name: 'Red', r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 }, // 0    0°
	{ name: 'Amber', r: 200, g: 150, b: 0, w: 0, a: 255, uv: 0 }, // 1   37°
	{ name: 'Lime', r: 150, g: 255, b: 0, w: 0, a: 0, uv: 0 }, // 2   85°
	{ name: 'Green', r: 0, g: 255, b: 85, w: 0, a: 0, uv: 0 }, // 3  140°
	{ name: 'Cyan', r: 0, g: 225, b: 255, w: 0, a: 0, uv: 0 }, // 4  187°
	{ name: 'Blue', r: 0, g: 85, b: 255, w: 0, a: 0, uv: 0 }, // 5  220°
	{ name: 'Congo Blue', r: 75, g: 0, b: 255, w: 0, a: 0, uv: 0 }, // 6  258°
	{ name: 'Violet', r: 205, g: 0, b: 255, w: 0, a: 0, uv: 0 }, // 7  288°
	{ name: 'Magenta', r: 255, g: 0, b: 150, w: 0, a: 0, uv: 0 }, // 8  325°
	// Whites, then the pale tier, then UV.
	{ name: 'Warm White', r: 90, g: 30, b: 0, w: 255, a: 200, uv: 0 }, // 9
	{ name: 'Cool White', r: 0, g: 30, b: 80, w: 255, a: 0, uv: 0 }, // 10
	{ name: 'Lavender', r: 130, g: 45, b: 200, w: 200, a: 0, uv: 0 }, // 11
	{ name: 'Moonlight', r: 0, g: 70, b: 190, w: 190, a: 0, uv: 0 }, // 12
	{ name: 'UV', r: 0, g: 0, b: 0, w: 0, a: 0, uv: 255 }, // 13
	{ name: 'Blackout', r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, // 14
]

export const PATTERNS = [
	{ id: 'solid', name: 'Solid' },
	{ id: 'fade', name: 'Fade' },
	{ id: 'hit', name: 'Hit' },
	{ id: 'strobe', name: 'Strobe' },
	{ id: 'color-cycle', name: 'Colour Cycle' },
	{ id: 'rainbow', name: 'Rainbow' },
	{ id: 'chase', name: 'Chase →' },
	{ id: 'chase-rev', name: 'Chase ←' },
	{ id: 'ping-pong', name: 'Ping Pong' },
	{ id: 'runner', name: 'Runner' },
	{ id: 'pairs', name: 'Pairs' },
	{ id: 'wave', name: 'Wave' },
	{ id: 'stack-up', name: 'Stack Up' },
	{ id: 'split', name: 'Split' },
	{ id: 'sections', name: 'Sections' },
	{ id: 'twinkle', name: 'Twinkle' },
	{ id: 'sparkle', name: 'Sparkle' },
	{ id: 'random-flash', name: 'Random Flash' },
	{ id: 'ensemble', name: 'Ensemble' },
	{ id: 'ribbon', name: 'Ribbon' },
	{ id: 'gradient', name: 'Gradient', pixel: true },
	{ id: 'comet', name: 'Comet', pixel: true },
	{ id: 'burst', name: 'Burst', pixel: true },
	{ id: 'plasma', name: 'Plasma', pixel: true },
	{ id: 'meter', name: 'Meter', pixel: true },
	{ id: 'drums', name: 'Drums', pixel: true },
	{ id: 'stems', name: 'Stems', pixel: true },
	{ id: 'rise', name: 'Rise', pixel: true },
	{ id: 'impact', name: 'Impact', pixel: true },
	{ id: 'bars', name: 'Bars', pixel: true },
	{ id: 'fire', name: 'Fire', pixel: true },
	{ id: 'rain', name: 'Rain', pixel: true },
	{ id: 'flash-chase', name: 'Flash Chase', pixel: true },
	{ id: 'flash-scatter', name: 'Flash Scatter', pixel: true },
	{ id: 'flash-fill', name: 'Flash Fill', pixel: true },
	{ id: 'flash-alternate', name: 'Flash Alternate', pixel: true },
	{ id: 'ramp', name: 'Ramp', pixel: true },
	{ id: 'core', name: 'Strobe Core', pixel: true },
]

export const ENERGY_EFFECTS = [
	{ id: 'white-strobe', name: 'White Strobe' },
	{ id: 'color-strobe', name: 'Colour Strobe' },
	{ id: 'blinder', name: 'Blinder' },
	{ id: 'uv-wash', name: 'UV Wash' },
	{ id: 'kill', name: 'Kill' },
	{ id: 'glow', name: 'Glow' },
]

export const STROBE_FUNCTIONS = [
	{ id: 'standard', name: 'Standard' },
	{ id: 'ramp-up-down', name: 'Ramp Up/Down' },
	{ id: 'ramp-up-down-rnd', name: 'Ramp Up/Down Rnd' },
	{ id: 'ramp-up', name: 'Ramp Up' },
	{ id: 'ramp-up-rnd', name: 'Ramp Up Rnd' },
	{ id: 'ramp-down', name: 'Ramp Down' },
	{ id: 'ramp-down-rnd', name: 'Ramp Down Rnd' },
	{ id: 'random', name: 'Random' },
	{ id: 'break', name: 'Break' },
]

/** What the auto show can follow (src/server/presets.ts AUTO_SOURCES). */
export const AUTO_SOURCES = [
	{ id: 'auto', name: 'Auto-detect' },
	{ id: 'hybrid', name: 'Spotify + OS clock' },
	{ id: 'spotify', name: 'Spotify' },
	{ id: 'deezer', name: 'Deezer' },
	{ id: 'nowplaying', name: 'Now playing (OS)' },
	{ id: 'prolink', name: 'PRO DJ LINK' },
	{ id: 'live', name: 'Live input (by ear)' },
	{ id: 'timer', name: 'Timer' },
]

/** How a pixel effect is laid over the rig (src/shared/rig.ts PIXEL_MAPS). */
export const PIXEL_MAPS = [
	{ id: 'stage', name: 'Across stage' },
	{ id: 'bar', name: 'Per bar' },
	{ id: 'mirror', name: 'Mirrored' },
]

// The colour slots the server exposes; C/D are used by 3- and 4-colour patterns.
export const COLOR_SLOTS = [
	{ id: 'colorA', label: 'A', actionId: 'set_color_a', feedbackId: 'color_a_active', defaultIndex: 0 },
	{ id: 'colorB', label: 'B', actionId: 'set_color_b', feedbackId: 'color_b_active', defaultIndex: 6 },
	{ id: 'colorC', label: 'C', actionId: 'set_color_c', feedbackId: 'color_c_active', defaultIndex: 4 },
	{ id: 'colorD', label: 'D', actionId: 'set_color_d', feedbackId: 'color_d_active', defaultIndex: 8 },
]

/** The state keys whose change changes what there is to choose from. */
export const CATALOG_KEYS = ['patterns', 'colorPresets', 'palettes', 'energyEffects', 'strobeFunctions', 'fixtures', 'cues']

const listed = (value, fallback) => (Array.isArray(value) && value.length ? value : fallback)

export const patternsOf = (state) => listed(state.patterns, PATTERNS)
export const colorsOf = (state) => listed(state.colorPresets, COLOR_PRESETS)
export const palettesOf = (state) => listed(state.palettes, [])
export const energyOf = (state) => listed(state.energyEffects, ENERGY_EFFECTS)
export const strobesOf = (state) => listed(state.strobeFunctions, STROBE_FUNCTIONS)
export const cuesOf = (state) => listed(state.cues, [])
export const fixturesOf = (state) => listed(state.fixtures, [])

/** A catalogue as a dropdown's choices. */
export const choices = (list) => list.map((item) => ({ id: item.id, label: item.name }))
export const colorChoices = (state) => colorsOf(state).map((c, i) => ({ id: i, label: c.name }))

/** A name from a catalogue, or the id itself when it is not in it. */
function nameIn(list, id) {
	const found = list.find((item) => item.id === id)
	return found ? found.name : id
}

export const patternName = (state, id) => nameIn(patternsOf(state), id)
export const energyName = (state, id) => nameIn(energyOf(state), id)
export const strobeName = (state, id) => nameIn(strobesOf(state), id)
export const paletteName = (state, id) => nameIn(palettesOf(state), id)
export const sourceName = (id) => nameIn(AUTO_SOURCES, id)
export const pixelMapName = (id) => nameIn(PIXEL_MAPS, id)
export const colorName = (state, index) => {
	const c = colorsOf(state)[index]
	return c ? c.name : String(index)
}

/**
 * The first colours of a palette, as preset objects, to draw a button with:
 * its duo when it has one.
 */
export function paletteSwatch(state, palette) {
	const indices = (palette.colors && (palette.colors[2] || palette.colors[4])) || []
	const table = colorsOf(state)
	return indices.map((i) => table[i]).filter(Boolean)
}
