import { combineRgb } from '@companion-module/base'
import {
	COLOR_SLOTS,
	PIXEL_MAPS,
	colorsOf,
	cuesOf,
	energyOf,
	fixturesOf,
	paletteSwatch,
	palettesOf,
	patternsOf,
	presetColor,
} from './constants.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const DARK = combineRgb(20, 20, 40)
const MAX_FIXTURE_BUTTONS = 16

/** A button that runs `down` on press and `up` on release. */
function button(name, style, down, { up = [], feedbacks = [] } = {}) {
	return {
		type: 'simple',
		name,
		style: { size: '14', color: WHITE, bgcolor: DARK, ...style },
		feedbacks,
		steps: [{ down, up }],
	}
}

/** Black or white text, whichever reads on `bg`. */
function textOn(bg) {
	const r = (bg >> 16) & 0xff
	const g = (bg >> 8) & 0xff
	const b = bg & 0xff
	return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? BLACK : WHITE
}

export function UpdatePresets(self) {
	const state = self.liveState
	const presets = {}
	const patterns = patternsOf(state)
	const pixels = patterns.filter((p) => p.pixel)
	const palettes = palettesOf(state)
	const energy = energyOf(state)
	const cues = cuesOf(state)
	const fixtures = fixturesOf(state).slice(0, MAX_FIXTURE_BUTTONS)

	// ── Busk: what a set needs under the fingers ──

	for (const palette of palettes) {
		const swatch = paletteSwatch(state, palette)
		const bg = swatch.length ? presetColor(swatch[0]) : DARK
		presets[`palette_${palette.id}`] = button(
			`Palette: ${palette.name}`,
			{ text: palette.name, bgcolor: bg, color: textOn(bg) },
			[{ actionId: 'set_palette', options: { palette: palette.id, size: 4 } }],
			{
				feedbacks: [
					{ feedbackId: 'palette_active', options: { palette: palette.id }, style: { bgcolor: WHITE, color: BLACK } },
				],
			},
		)
	}

	// Momentary: on while the button is down, and gone on its own if the
	// connection drops with it down.
	for (const e of energy) {
		presets[`hold_${e.id}`] = button(
			`Hold: ${e.name}`,
			{ text: `HOLD\n${e.name}`, color: combineRgb(255, 200, 200), bgcolor: combineRgb(60, 10, 10) },
			[{ actionId: 'energy_hold', options: { mode: 'press', effect: e.id } }],
			{
				up: [{ actionId: 'energy_hold', options: { mode: 'release', effect: e.id } }],
				feedbacks: [
					{ feedbackId: 'energy_override_active', options: { effect: e.id }, style: { bgcolor: combineRgb(255, 30, 30), color: WHITE } },
				],
			},
		)
	}
	presets['hold_blackout'] = button(
		'Hold: Blackout',
		{ text: 'HOLD\nBLACK', color: combineRgb(255, 80, 80), bgcolor: combineRgb(40, 0, 0) },
		[{ actionId: 'master_blackout', options: { mode: 'on' } }],
		{
			up: [{ actionId: 'master_blackout', options: { mode: 'off' } }],
			feedbacks: [{ feedbackId: 'blackout_active', options: {}, style: { bgcolor: combineRgb(220, 0, 0), color: WHITE } }],
		},
	)

	presets['tempo_double'] = button('BPM ×2', { text: 'BPM\n×2', size: '18' }, [
		{ actionId: 'multiply_bpm', options: { factor: 2 } },
	])
	presets['tempo_halve'] = button('BPM ÷2', { text: 'BPM\n÷2', size: '18' }, [
		{ actionId: 'multiply_bpm', options: { factor: 0.5 } },
	])

	presets['auto_toggle'] = button(
		'Auto Show',
		{ text: 'AUTO\nSHOW', size: '18', bgcolor: combineRgb(0, 40, 30) },
		[{ actionId: 'auto_show', options: { mode: 'toggle' } }],
		{ feedbacks: [{ feedbackId: 'auto_show_on', options: {}, style: { bgcolor: combineRgb(0, 160, 120), color: WHITE, text: 'AUTO\n● ON' } }] },
	)
	presets['auto_intensity_display'] = button(
		'Auto Intensity',
		{ text: 'ENERGY\n$(artnet-lightshow:auto_intensity)', size: '14' },
		[],
	)
	for (const delta of [10, -10]) {
		presets[`auto_intensity_${delta > 0 ? 'up' : 'down'}`] = button(
			`Auto Intensity ${delta > 0 ? '+' : ''}${delta}`,
			{ text: `ENERGY\n${delta > 0 ? '+' : ''}${delta}`, size: '14' },
			[{ actionId: 'auto_intensity', options: { mode: 'adjust', value: delta } }],
		)
	}
	for (const delta of [20, -20]) {
		presets[`sync_${delta > 0 ? 'earlier' : 'later'}`] = button(
			`Sync ${delta > 0 ? 'earlier' : 'later'} ${Math.abs(delta)} ms`,
			{ text: `SYNC\n${delta > 0 ? '+' : ''}${delta}ms`, size: '14' },
			[{ actionId: 'nudge_sync', options: { delta } }],
		)
	}
	presets['track_display'] = button('Now playing', { text: '$(artnet-lightshow:track)', size: '7' }, [])

	for (const cue of cues) {
		presets[`cue_${cue.id}`] = button(
			`Cue: ${cue.name}`,
			{ text: cue.name, size: '14', bgcolor: combineRgb(40, 30, 0), color: combineRgb(255, 220, 150) },
			[{ actionId: 'recall_cue', options: { cue: cue.id } }],
		)
	}

	// ── Patterns ──

	for (const p of patterns) {
		presets[`pattern_${p.id}`] = button(
			p.name,
			{ text: p.name, size: '18', color: combineRgb(220, 220, 255), bgcolor: combineRgb(20, 20, 40) },
			[{ actionId: 'set_pattern', options: { pattern: p.id, fadeMs: 0 } }],
			{ feedbacks: [{ feedbackId: 'pattern_active', options: { pattern: p.id }, style: { bgcolor: combineRgb(80, 60, 255), color: WHITE } }] },
		)
	}
	for (const p of [{ id: 'none', name: 'Whole rig' }, ...pixels]) {
		presets[`bars_${p.id}`] = button(
			`Bars: ${p.name}`,
			{ text: `BARS\n${p.name}`, size: '14', color: combineRgb(200, 230, 255), bgcolor: combineRgb(0, 30, 50) },
			[{ actionId: 'set_pixel_pattern', options: { pattern: p.id } }],
			{ feedbacks: [{ feedbackId: 'pixel_pattern_active', options: { pattern: p.id }, style: { bgcolor: combineRgb(0, 120, 200), color: WHITE } }] },
		)
	}
	for (const p of [{ id: 'none', name: 'As the bars' }, ...pixels]) {
		presets[`panels_${p.id}`] = button(
			`Panels: ${p.name}`,
			{ text: `PANELS\n${p.name}`, size: '14', color: combineRgb(255, 220, 190), bgcolor: combineRgb(50, 20, 0) },
			[{ actionId: 'set_panel_pattern', options: { pattern: p.id } }],
			{ feedbacks: [{ feedbackId: 'panel_pattern_active', options: { pattern: p.id }, style: { bgcolor: combineRgb(160, 60, 0), color: WHITE } }] },
		)
	}
	for (const m of PIXEL_MAPS) {
		presets[`map_${m.id}`] = button(
			`Pixel map: ${m.name}`,
			{ text: m.name, size: '14', color: combineRgb(200, 230, 255), bgcolor: combineRgb(0, 30, 50) },
			[{ actionId: 'set_pixel_map', options: { map: m.id } }],
			{ feedbacks: [{ feedbackId: 'pixel_map_active', options: { map: m.id }, style: { bgcolor: combineRgb(0, 120, 200), color: WHITE } }] },
		)
	}

	// ── Colour slots A-D ──

	const table = colorsOf(state)
	for (const slot of COLOR_SLOTS) {
		table.forEach((c, i) => {
			const bg = presetColor(c)
			presets[`color_${slot.label.toLowerCase()}_${i}`] = button(
				`${slot.label}: ${c.name}`,
				{ text: c.name, bgcolor: bg },
				[{ actionId: slot.actionId, options: { color: i } }],
				{ feedbacks: [{ feedbackId: slot.feedbackId, options: { color: i }, style: { bgcolor: bg, color: BLACK, text: `${slot.label}\n${c.name}` } }] },
			)
		})
	}

	// ── Transport ──

	presets['transport_play_stop'] = button(
		'Play / Stop',
		{ text: 'PLAY\nSTOP', size: '18', color: combineRgb(220, 220, 220), bgcolor: combineRgb(0, 50, 0) },
		[{ actionId: 'play_stop', options: { mode: 'toggle' } }],
		{ feedbacks: [{ feedbackId: 'playing', options: {}, style: { bgcolor: combineRgb(0, 180, 60), color: WHITE, text: '▶ PLAY' } }] },
	)
	presets['transport_blackout'] = button(
		'Master Blackout',
		{ text: 'BLACK\nOUT', size: '18', color: combineRgb(255, 80, 80), bgcolor: combineRgb(40, 0, 0) },
		[{ actionId: 'master_blackout', options: { mode: 'toggle' } }],
		{ feedbacks: [{ feedbackId: 'blackout_active', options: {}, style: { bgcolor: combineRgb(220, 0, 0), color: WHITE } }] },
	)
	presets['transport_tap_tempo'] = button(
		'Tap Tempo',
		{ text: 'TAP\nTEMPO', size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(30, 30, 80) },
		[{ actionId: 'tap_tempo', options: {} }],
	)
	presets['transport_bpm_display'] = {
		type: 'simple',
		name: 'BPM Display',
		style: { text: '$(artnet-lightshow:bpm)\nBPM', size: '18', color: WHITE, bgcolor: DARK },
		feedbacks: [],
		steps: [],
	}
	for (const delta of [5, -5]) {
		presets[`transport_bpm_${delta > 0 ? 'up' : 'down'}`] = button(
			`BPM ${delta > 0 ? '+' : ''}${delta}`,
			{ text: `BPM ${delta > 0 ? '+' : ''}${delta}`, size: '18', color: combineRgb(200, 200, 200) },
			[{ actionId: 'adjust_bpm', options: { delta } }],
		)
	}
	const beatDivisions = [
		{ div: 1, label: '1/1' },
		{ div: 2, label: '1/2' },
		{ div: 4, label: '1/4' },
		{ div: 8, label: '1/8' },
	]
	for (const { div, label } of beatDivisions) {
		presets[`transport_beat_${div}`] = button(
			`Beat ${label}`,
			{ text: `BEAT\n${label}`, size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(20, 20, 60) },
			[{ actionId: 'beat_division', options: { div } }],
		)
	}
	for (const delta of [25, -25]) {
		presets[`master_${delta > 0 ? 'up' : 'down'}`] = button(
			`Master ${delta > 0 ? '+' : '−'}10%`,
			{ text: `MASTER\n${delta > 0 ? '+' : '−'}10%`, size: '14' },
			[{ actionId: 'adjust_master_dimmer', options: { delta } }],
		)
	}
	presets['master_display'] = button('Master', { text: 'MASTER\n$(artnet-lightshow:master_dimmer_pct)%', size: '14' }, [])

	// ── Fixtures ──

	const fixtureNumbers = fixtures.length ? fixtures.map((f) => ({ n: f.id + 1, label: f.label })) : [1, 2, 3, 4].map((n) => ({ n, label: `PAR ${n}` }))
	for (const { n, label } of fixtureNumbers) {
		presets[`fixture_${n}_blackout`] = button(
			`${label} Blackout`,
			{ text: `${label}\nBLACK`, color: combineRgb(255, 80, 80), bgcolor: combineRgb(30, 0, 0) },
			[{ actionId: 'fixture_blackout', options: { fixture: n, mode: 'toggle' } }],
			{ feedbacks: [{ feedbackId: 'fixture_blackout', options: { fixture: n }, style: { bgcolor: combineRgb(200, 0, 0), color: WHITE } }] },
		)
	}
	presets['fixture_clear_all'] = button(
		'Clear All Overrides',
		{ text: 'CLEAR\nOVERRIDE', color: combineRgb(200, 200, 200), bgcolor: combineRgb(20, 20, 20) },
		[{ actionId: 'fixture_clear', options: { fixture: 'all' } }],
	)

	// ── Energy, latched ──

	for (const e of energy) {
		presets[`energy_${e.id}`] = button(
			`Latch: ${e.name}`,
			{ text: `⚡\n${e.name}`, color: combineRgb(255, 200, 200), bgcolor: combineRgb(60, 10, 10) },
			[{ actionId: 'energy_override', options: { effect: e.id } }],
			{ feedbacks: [{ feedbackId: 'energy_override_active', options: { effect: e.id }, style: { bgcolor: combineRgb(255, 30, 30), color: WHITE } }] },
		)
	}
	presets['energy_off'] = button('Energy Off', { text: '⚡\nOFF', color: combineRgb(200, 200, 200) }, [
		{ actionId: 'energy_override_off', options: {} },
	])

	const group = (id, name, ids) => ({ id, type: 'simple', name, presets: ids })
	const structure = [
		{
			id: 'busk',
			name: 'Busk',
			description: 'Palettes, momentary holds, tempo and the auto show: a set played by hand',
			definitions: [
				group('busk_palettes', 'Palettes', palettes.map((p) => `palette_${p.id}`)),
				group('busk_holds', 'Hold (on while pressed)', [...energy.map((e) => `hold_${e.id}`), 'hold_blackout']),
				group('busk_tempo', 'Tempo', ['transport_tap_tempo', 'transport_bpm_display', 'tempo_double', 'tempo_halve', 'transport_bpm_up', 'transport_bpm_down']),
				group('busk_auto', 'Auto show', ['auto_toggle', 'auto_intensity_display', 'auto_intensity_up', 'auto_intensity_down', 'sync_earlier', 'sync_later', 'track_display']),
				group('busk_master', 'Master', ['master_display', 'master_up', 'master_down', 'transport_blackout']),
				...(cues.length ? [group('busk_cues', 'Cues', cues.map((c) => `cue_${c.id}`))] : []),
			],
		},
		{
			id: 'patterns',
			name: 'Patterns',
			description: 'Switch the running pattern; the active one lights up. The bars and the panels can run a picture of their own',
			definitions: [
				group('patterns_rig', 'Whole rig', patterns.filter((p) => !p.pixel).map((p) => `pattern_${p.id}`)),
				group('patterns_pixel', 'Pixel effects', pixels.map((p) => `pattern_${p.id}`)),
				group('patterns_bars', 'The bars\' own picture', ['bars_none', ...pixels.map((p) => `bars_${p.id}`)]),
				group('patterns_panels', 'The panels\' own picture', ['panels_none', ...pixels.map((p) => `panels_${p.id}`)]),
				group('patterns_map', 'Pixel map', PIXEL_MAPS.map((m) => `map_${m.id}`)),
			],
		},
		{
			id: 'colours',
			name: 'Colours',
			description: 'Palette slots A-D. C and D feed the 3- and 4-colour patterns',
			definitions: COLOR_SLOTS.map((slot) =>
				group(`colour_${slot.label.toLowerCase()}`, `Colour ${slot.label}`, table.map((_, i) => `color_${slot.label.toLowerCase()}_${i}`)),
			),
		},
		{
			id: 'transport',
			name: 'Transport',
			definitions: [
				'transport_play_stop',
				'transport_blackout',
				'transport_tap_tempo',
				'transport_bpm_display',
				'transport_bpm_up',
				'transport_bpm_down',
				...beatDivisions.map(({ div }) => `transport_beat_${div}`),
			],
		},
		{
			id: 'fixtures',
			name: 'Fixtures',
			definitions: [...fixtureNumbers.map(({ n }) => `fixture_${n}_blackout`), 'fixture_clear_all'],
		},
		{
			id: 'energy',
			name: 'Energy',
			description: 'Latched energy effects: on until another replaces it or Energy Off. For momentary ones, see Busk → Hold',
			definitions: [...energy.map((e) => `energy_${e.id}`), 'energy_off'],
		},
	]

	self.setPresetDefinitions(structure, presets)
}
