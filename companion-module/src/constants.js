import { combineRgb } from '@companion-module/base'

// These lists mirror src/server/presets.js — colour slots are sent to the
// server as palette indices, so order matters. Keep them in sync.

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
]

export const ENERGY_EFFECTS = [
	{ id: 'white-strobe', name: 'White Strobe' },
	{ id: 'color-strobe', name: 'Colour Strobe' },
	{ id: 'blinder', name: 'Blinder' },
	{ id: 'uv-wash', name: 'UV Wash' },
	{ id: 'kill', name: 'Kill' },
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

export const FIXTURE_COUNT = 4

// The colour slots the server exposes; C/D are used by 3- and 4-colour patterns.
export const COLOR_SLOTS = [
	{ id: 'colorA', label: 'A', actionId: 'set_color_a', feedbackId: 'color_a_active', defaultIndex: 0 },
	{ id: 'colorB', label: 'B', actionId: 'set_color_b', feedbackId: 'color_b_active', defaultIndex: 6 },
	{ id: 'colorC', label: 'C', actionId: 'set_color_c', feedbackId: 'color_c_active', defaultIndex: 4 },
	{ id: 'colorD', label: 'D', actionId: 'set_color_d', feedbackId: 'color_d_active', defaultIndex: 8 },
]

export const PATTERN_CHOICES = PATTERNS.map((p) => ({ id: p.id, label: p.name }))
export const COLOR_CHOICES = COLOR_PRESETS.map((c, i) => ({ id: i, label: c.name }))
export const ENERGY_CHOICES = ENERGY_EFFECTS.map((e) => ({ id: e.id, label: e.name }))
export const STROBE_CHOICES = STROBE_FUNCTIONS.map((f) => ({ id: f.id, label: f.name }))

export function patternName(id) {
	const p = PATTERNS.find((p) => p.id === id)
	return p ? p.name : id
}

export function colorName(index) {
	const c = COLOR_PRESETS[index]
	return c ? c.name : String(index)
}

export function energyName(id) {
	const e = ENERGY_EFFECTS.find((e) => e.id === id)
	return e ? e.name : id
}

export function strobeName(id) {
	const f = STROBE_FUNCTIONS.find((f) => f.id === id)
	return f ? f.name : id
}

// Map an RGBWAUV palette entry to a Companion RGB colour for button previews.
// White lifts all channels, amber reads as warm orange, UV as blue-purple.
// Mirrors colorToCss in public-src/utils.js, including the proportional
// scale-back: clamping each channel at 255 made every white-heavy preset come
// out the same flat white, so Warm White and Cool White were indistinguishable
// on the buttons.
export function presetColor(c) {
	const w = c.w || 0
	const a = c.a || 0
	const uv = c.uv || 0
	const rgb = [c.r + w + a + uv * 0.2, c.g + w + a * 0.5, c.b + w + uv * 0.9]
	const peak = Math.max(...rgb)
	const k = peak > 255 ? 255 / peak : 1
	return combineRgb(...rgb.map((v) => Math.round(v * k)))
}
