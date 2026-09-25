import { combineRgb } from '@companion-module/base'

// The lists live in catalog.js, which has no Companion imports so the tests
// can load it; this re-exports them for the rest of the module.
export * from './catalog.js'

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
