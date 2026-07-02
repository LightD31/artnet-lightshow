import { combineRgb } from '@companion-module/base'

// These lists mirror src/server/presets.js — colour slots are sent to the
// server as palette indices, so order matters. Keep them in sync.

export const COLOR_PRESETS = [
	{ name: 'Crimson', r: 255, g: 18, b: 8, w: 0, a: 0, uv: 0 }, // 0
	{ name: 'Flame', r: 255, g: 94, b: 0, w: 0, a: 130, uv: 0 }, // 1
	{ name: 'Amber', r: 70, g: 20, b: 0, w: 0, a: 255, uv: 0 }, // 2
	{ name: 'Sun', r: 255, g: 220, b: 18, w: 0, a: 120, uv: 0 }, // 3
	{ name: 'Lime', r: 40, g: 255, b: 40, w: 0, a: 0, uv: 0 }, // 4
	{ name: 'Aqua', r: 0, g: 225, b: 255, w: 0, a: 0, uv: 0 }, // 5
	{ name: 'Cobalt', r: 20, g: 60, b: 255, w: 0, a: 0, uv: 0 }, // 6
	{ name: 'Violet', r: 115, g: 20, b: 255, w: 0, a: 0, uv: 0 }, // 7
	{ name: 'Fuchsia', r: 255, g: 0, b: 165, w: 0, a: 0, uv: 0 }, // 8
	{ name: 'Daylight White', r: 0, g: 0, b: 0, w: 255, a: 0, uv: 0 }, // 9
	{ name: 'UV', r: 0, g: 0, b: 0, w: 0, a: 0, uv: 255 }, // 10
	{ name: 'Actinic', r: 85, g: 0, b: 255, w: 0, a: 0, uv: 0 }, // 11
	{ name: 'Rose', r: 255, g: 84, b: 182, w: 0, a: 0, uv: 0 }, // 12
	{ name: 'Teal', r: 0, g: 188, b: 160, w: 0, a: 0, uv: 0 }, // 13
	{ name: 'Gold', r: 255, g: 155, b: 20, w: 0, a: 225, uv: 0 }, // 14
	{ name: 'Tungsten White', r: 95, g: 35, b: 0, w: 255, a: 175, uv: 0 }, // 15
	{ name: 'Mint', r: 0, g: 255, b: 145, w: 0, a: 0, uv: 0 }, // 16
	{ name: 'Sky', r: 80, g: 185, b: 255, w: 0, a: 0, uv: 0 }, // 17
	{ name: 'Indigo', r: 35, g: 0, b: 190, w: 0, a: 0, uv: 0 }, // 18
	{ name: 'Coral', r: 255, g: 112, b: 78, w: 0, a: 55, uv: 0 }, // 19
	{ name: 'Lavender', r: 165, g: 120, b: 255, w: 0, a: 0, uv: 0 }, // 20
	{ name: 'Acid', r: 186, g: 255, b: 0, w: 0, a: 0, uv: 0 }, // 21
	{ name: 'Moonlight', r: 30, g: 45, b: 85, w: 180, a: 0, uv: 0 }, // 22
	{ name: 'Blackout', r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }, // 23
]

export const PATTERNS = [
	{ id: 'solid', name: 'Solid' },
	{ id: 'chase', name: 'Chase →' },
	{ id: 'chase-rev', name: 'Chase ←' },
	{ id: 'ping-pong', name: 'Ping Pong' },
	{ id: 'strobe', name: 'Strobe' },
	{ id: 'fade', name: 'Fade' },
	{ id: 'color-cycle', name: 'Colour Cycle' },
	{ id: 'rainbow', name: 'Rainbow' },
	{ id: 'twinkle', name: 'Twinkle' },
	{ id: 'split', name: 'Split' },
	{ id: 'sparkle', name: 'Sparkle' },
	{ id: 'wave', name: 'Wave' },
	{ id: 'stack-up', name: 'Stack Up' },
	{ id: 'random-flash', name: 'Random Flash' },
	{ id: 'runner', name: 'Runner' },
	{ id: 'pairs', name: 'Pairs' },
	{ id: 'hit', name: 'Hit' },
	{ id: 'alt-halves', name: 'Alt Halves' },
	{ id: 'split-3', name: 'Split 3' },
	{ id: 'chase-3', name: 'Chase 3' },
	{ id: 'alt-thirds', name: 'Alt Thirds' },
	{ id: 'split-4', name: 'Split 4' },
	{ id: 'chase-4', name: 'Chase 4' },
	{ id: 'alt-quarters', name: 'Alt Quarters' },
	{ id: 'pairs-4', name: 'Pairs 4' },
]

export const ENERGY_EFFECTS = [
	{ id: 'white-strobe', name: 'White Strobe' },
	{ id: 'blinder', name: 'Blinder' },
	{ id: 'uv-strobe', name: 'UV Strobe' },
	{ id: 'color-strobe', name: 'Colour Strobe' },
	{ id: 'all-on', name: 'All On' },
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
	{ id: 'colorC', label: 'C', actionId: 'set_color_c', feedbackId: 'color_c_active', defaultIndex: 3 },
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
export function presetColor(c) {
	const w = c.w || 0
	const a = c.a || 0
	const uv = c.uv || 0
	return combineRgb(
		Math.min(255, c.r + w + Math.round(a * 1.0) + Math.round(uv * 0.2)),
		Math.min(255, c.g + w + Math.round(a * 0.5)),
		Math.min(255, c.b + w + Math.round(uv * 0.9)),
	)
}
