import { combineRgb } from '@companion-module/base'

export * from './catalog.js'

// Scale the whole mix so white-heavy presets retain their colour temperature.
export function presetColor(c) {
	const w = c.w || 0
	const a = c.a || 0
	const uv = c.uv || 0
	const rgb = [c.r + w + a + uv * 0.2, c.g + w + a * 0.5, c.b + w + uv * 0.9]
	const peak = Math.max(...rgb)
	const k = peak > 255 ? 255 / peak : 1
	return combineRgb(...rgb.map((v) => Math.round(v * k)))
}
