import { combineRgb } from '@companion-module/base'
import { COLOR_PRESETS, COLOR_SLOTS, ENERGY_EFFECTS, FIXTURE_COUNT, PATTERNS, presetColor } from './constants.js'

const WHITE = combineRgb(255, 255, 255)

export function UpdatePresets(self) {
	const presets = {}

	// ── Patterns ──
	for (const p of PATTERNS) {
		presets[`pattern_${p.id}`] = {
			type: 'simple',
			name: p.name,
			style: {
				text: p.name,
				size: '18',
				color: combineRgb(220, 220, 255),
				bgcolor: combineRgb(20, 20, 40),
			},
			feedbacks: [
				{
					feedbackId: 'pattern_active',
					options: { pattern: p.id },
					style: { bgcolor: combineRgb(80, 60, 255), color: WHITE },
				},
			],
			steps: [{ down: [{ actionId: 'set_pattern', options: { pattern: p.id } }], up: [] }],
		}
	}

	// ── Colour slots A-D ──
	for (const slot of COLOR_SLOTS) {
		COLOR_PRESETS.forEach((c, i) => {
			const bg = presetColor(c)
			presets[`color_${slot.label.toLowerCase()}_${i}`] = {
				type: 'simple',
				name: `${slot.label}: ${c.name}`,
				style: {
					text: c.name,
					size: '14',
					color: WHITE,
					bgcolor: bg,
				},
				feedbacks: [
					{
						feedbackId: slot.feedbackId,
						options: { color: i },
						style: { bgcolor: bg, color: combineRgb(0, 0, 0), text: `${slot.label}\n${c.name}` },
					},
				],
				steps: [{ down: [{ actionId: slot.actionId, options: { color: i } }], up: [] }],
			}
		})
	}

	// ── Transport ──
	presets['transport_play_stop'] = {
		type: 'simple',
		name: 'Play / Stop',
		style: { text: 'PLAY\nSTOP', size: '18', color: combineRgb(220, 220, 220), bgcolor: combineRgb(0, 50, 0) },
		feedbacks: [
			{
				feedbackId: 'playing',
				options: {},
				style: { bgcolor: combineRgb(0, 180, 60), color: WHITE, text: '▶ PLAY' },
			},
		],
		steps: [{ down: [{ actionId: 'play_stop', options: { mode: 'toggle' } }], up: [] }],
	}

	presets['transport_blackout'] = {
		type: 'simple',
		name: 'Master Blackout',
		style: { text: 'BLACK\nOUT', size: '18', color: combineRgb(255, 80, 80), bgcolor: combineRgb(40, 0, 0) },
		feedbacks: [
			{
				feedbackId: 'blackout_active',
				options: {},
				style: { bgcolor: combineRgb(220, 0, 0), color: WHITE },
			},
		],
		steps: [{ down: [{ actionId: 'master_blackout', options: { mode: 'toggle' } }], up: [] }],
	}

	presets['transport_tap_tempo'] = {
		type: 'simple',
		name: 'Tap Tempo',
		style: { text: 'TAP\nTEMPO', size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(30, 30, 80) },
		feedbacks: [],
		steps: [{ down: [{ actionId: 'tap_tempo', options: {} }], up: [] }],
	}

	presets['transport_bpm_display'] = {
		type: 'simple',
		name: 'BPM Display',
		style: { text: '$(artnet-lightshow:bpm)\nBPM', size: '18', color: WHITE, bgcolor: combineRgb(20, 20, 40) },
		feedbacks: [],
		steps: [],
	}

	for (const delta of [5, -5]) {
		presets[`transport_bpm_${delta > 0 ? 'up' : 'down'}`] = {
			type: 'simple',
			name: `BPM ${delta > 0 ? '+' : ''}${delta}`,
			style: {
				text: `BPM ${delta > 0 ? '+' : ''}${delta}`,
				size: '18',
				color: combineRgb(200, 200, 200),
				bgcolor: combineRgb(20, 20, 40),
			},
			feedbacks: [],
			steps: [{ down: [{ actionId: 'adjust_bpm', options: { delta } }], up: [] }],
		}
	}

	const beatDivisions = [
		{ div: 1, label: '1/1' },
		{ div: 2, label: '1/2' },
		{ div: 4, label: '1/4' },
		{ div: 8, label: '1/8' },
	]
	for (const { div, label } of beatDivisions) {
		presets[`transport_beat_${div}`] = {
			type: 'simple',
			name: `Beat ${label}`,
			style: { text: `BEAT\n${label}`, size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(20, 20, 60) },
			feedbacks: [],
			steps: [{ down: [{ actionId: 'beat_division', options: { div } }], up: [] }],
		}
	}

	// ── Fixtures ──
	for (let i = 1; i <= FIXTURE_COUNT; i++) {
		presets[`fixture_${i}_blackout`] = {
			type: 'simple',
			name: `PAR ${i} Blackout`,
			style: { text: `PAR ${i}\nBLACK`, size: '14', color: combineRgb(255, 80, 80), bgcolor: combineRgb(30, 0, 0) },
			feedbacks: [
				{
					feedbackId: 'fixture_blackout',
					options: { fixture: i },
					style: { bgcolor: combineRgb(200, 0, 0), color: WHITE },
				},
			],
			steps: [{ down: [{ actionId: 'fixture_blackout', options: { fixture: i, mode: 'toggle' } }], up: [] }],
		}
	}

	presets['fixture_clear_all'] = {
		type: 'simple',
		name: 'Clear All Overrides',
		style: { text: 'CLEAR\nOVERRIDE', size: '14', color: combineRgb(200, 200, 200), bgcolor: combineRgb(20, 20, 20) },
		feedbacks: [],
		steps: [{ down: [{ actionId: 'fixture_clear', options: { fixture: 'all' } }], up: [] }],
	}

	// ── Energy (momentary: hold to activate, release to clear) ──
	for (const e of ENERGY_EFFECTS) {
		presets[`energy_${e.id}`] = {
			type: 'simple',
			name: e.name,
			style: {
				text: `⚡\n${e.name}`,
				size: '14',
				color: combineRgb(255, 200, 200),
				bgcolor: combineRgb(60, 10, 10),
			},
			feedbacks: [
				{
					feedbackId: 'energy_override_active',
					options: { effect: e.id },
					style: { bgcolor: combineRgb(255, 30, 30), color: WHITE },
				},
			],
			steps: [
				{
					down: [{ actionId: 'energy_override', options: { effect: e.id } }],
					up: [{ actionId: 'energy_override_off', options: {} }],
				},
			],
		}
	}

	const structure = [
		{
			id: 'patterns',
			name: 'Patterns',
			description: 'Switch the running pattern; the active one lights up',
			definitions: PATTERNS.map((p) => `pattern_${p.id}`),
		},
		{
			id: 'colours',
			name: 'Colours',
			description: 'Palette slots A-D. C and D feed the 3- and 4-colour patterns',
			definitions: COLOR_SLOTS.map((slot) => ({
				id: `colour_${slot.label.toLowerCase()}`,
				type: 'simple',
				name: `Colour ${slot.label}`,
				presets: COLOR_PRESETS.map((_, i) => `color_${slot.label.toLowerCase()}_${i}`),
			})),
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
			definitions: [
				...Array.from({ length: FIXTURE_COUNT }, (_, i) => `fixture_${i + 1}_blackout`),
				'fixture_clear_all',
			],
		},
		{
			id: 'energy',
			name: 'Energy',
			description: 'Momentary boosts: hold to activate, release to clear',
			definitions: ENERGY_EFFECTS.map((e) => `energy_${e.id}`),
		},
	]

	self.setPresetDefinitions(structure, presets)
}
