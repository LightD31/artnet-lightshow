import { combineRgb } from '@companion-module/base'
import {
	AUTO_SOURCES,
	COLOR_SLOTS,
	PIXEL_MAPS,
	choices,
	colorChoices,
	cuesOf,
	energyOf,
	fixturesOf,
	palettesOf,
	patternsOf,
	strobesOf,
} from './constants.js'

const MODE_TOGGLE = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
]

export function UpdateActions(self) {
	const state = self.liveState
	const fixtureForNumber = (number) => fixturesOf(state).find((fixture) => fixture.id === Number(number) - 1)
	const fixtureChoices = fixturesOf(state).length
		? fixturesOf(state).map((fixture) => ({ id: fixture.id + 1, label: `${fixture.id + 1}: ${fixture.label}` }))
		: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, label: `PAR ${i + 1}` }))
	const patternChoices = choices(patternsOf(state))
	const pixelChoices = [
		{ id: 'none', label: 'None — one pattern on the whole rig' },
		...choices(patternsOf(state).filter((p) => p.pixel)),
	]
	const paletteChoices = choices(palettesOf(state))
	const energyChoices = choices(energyOf(state))
	const cueChoices = cuesOf(state).map((cue) => ({ id: cue.id, label: cue.name }))
	const limit = Number.isFinite(state.syncOffsetLimitMs) ? state.syncOffsetLimitMs : 2000

	const actions = {
		set_pattern: {
			name: 'Set Pattern',
			options: [
				{ type: 'dropdown', id: 'pattern', label: 'Pattern', default: 'chase', choices: patternChoices },
				{
					type: 'number',
					id: 'fadeMs',
					label: 'Crossfade (ms, 0 cuts)',
					default: 0,
					min: 0,
					max: 10000,
				},
			],
			callback: ({ options }) =>
				self.sendSet({ pattern: options.pattern, ...(options.fadeMs > 0 ? { fadeMs: options.fadeMs } : {}) }),
		},

		set_pixel_pattern: {
			name: 'Set Bars Pattern (the LED bars\' own picture)',
			options: [
				{ type: 'dropdown', id: 'pattern', label: 'Pixel effect', default: 'none', choices: pixelChoices },
			],
			callback: ({ options }) => self.sendSet({ pixelPattern: options.pattern === 'none' ? null : options.pattern }),
		},

		set_panel_pattern: {
			name: 'Set Panels Pattern (the panels\' own picture)',
			options: [
				{
					type: 'dropdown',
					id: 'pattern',
					label: 'Pixel effect',
					default: 'none',
					choices: [{ id: 'none', label: 'None — the panels draw what the bars do' }, ...pixelChoices.slice(1)],
				},
			],
			callback: ({ options }) => self.sendSet({ panelPattern: options.pattern === 'none' ? null : options.pattern }),
		},

		set_pixel_map: {
			name: 'Set Pixel Map',
			options: [
				{ type: 'dropdown', id: 'map', label: 'Lay the picture', default: 'stage', choices: choices(PIXEL_MAPS) },
			],
			callback: ({ options }) => self.sendSet({ pixelMap: options.map }),
		},

		set_palette: {
			name: 'Set Palette',
			options: [
				{
					type: 'dropdown',
					id: 'palette',
					label: 'Palette',
					default: paletteChoices[0]?.id ?? '',
					choices: paletteChoices,
					allowCustom: true,
				},
				{
					type: 'dropdown',
					id: 'size',
					label: 'Colours',
					default: 4,
					choices: [
						{ id: 2, label: '2' },
						{ id: 3, label: '3' },
						{ id: 4, label: '4' },
					],
				},
			],
			callback: ({ options }) => {
				if (!options.palette) return
				self.sendSet({ palette: options.palette, paletteSize: Number(options.size) || 4 })
			},
		},

		set_bpm: {
			name: 'Set BPM',
			options: [{ type: 'number', id: 'bpm', label: 'BPM', default: 120, min: 20, max: 300 }],
			callback: ({ options }) => self.sendSet({ bpm: options.bpm }),
		},

		adjust_bpm: {
			name: 'Adjust BPM',
			options: [{ type: 'number', id: 'delta', label: 'Amount (±)', default: 5, min: -100, max: 100 }],
			callback: ({ options }) => {
				const current = self.liveState.bpm || 120
				self.sendSet({ bpm: Math.max(20, Math.min(300, Math.round((current + options.delta) * 100) / 100)) })
			},
		},

		multiply_bpm: {
			name: 'Double / Halve BPM',
			options: [
				{
					type: 'dropdown',
					id: 'factor',
					label: 'Tempo',
					default: 2,
					choices: [
						{ id: 2, label: 'Double (×2)' },
						{ id: 0.5, label: 'Halve (÷2)' },
					],
				},
			],
			callback: ({ options }) => {
				const next = (self.liveState.bpm || 120) * Number(options.factor)
				if (next >= 20 && next <= 300) self.sendSet({ bpm: Math.round(next * 100) / 100 })
			},
		},

		tap_tempo: {
			name: 'Tap Tempo',
			options: [],
			callback: () => self.sendTap(),
		},

		set_master_dimmer: {
			name: 'Set Master Dimmer',
			options: [{ type: 'number', id: 'value', label: 'Level (0-255)', default: 255, min: 0, max: 255 }],
			callback: ({ options }) => self.sendSet({ masterDimmer: options.value }),
		},

		adjust_master_dimmer: {
			name: 'Adjust Master Dimmer',
			options: [{ type: 'number', id: 'delta', label: 'Amount (±, of 255)', default: 25, min: -255, max: 255 }],
			callback: ({ options }) => {
				const current = Number.isFinite(self.liveState.masterDimmer) ? self.liveState.masterDimmer : 255
				self.sendSet({ masterDimmer: Math.max(0, Math.min(255, current + options.delta)) })
			},
		},

		master_blackout: {
			name: 'Master Blackout',
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: MODE_TOGGLE }],
			callback: ({ options }) => {
				const cur = self.liveState.masterBlackout
				const next = options.mode === 'toggle' ? !cur : options.mode === 'on'
				self.sendSet({ masterBlackout: next })
			},
		},

		play_stop: {
			name: 'Play / Stop',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'play', label: 'Play' },
						{ id: 'stop', label: 'Stop' },
					],
				},
			],
			callback: ({ options }) => {
				const cur = self.liveState.running
				const next = options.mode === 'toggle' ? !cur : options.mode === 'play'
				self.sendSet({ running: next })
			},
		},

		beat_division: {
			name: 'Set Beat Division',
			options: [
				{
					type: 'dropdown',
					id: 'div',
					label: 'Division',
					default: 1,
					choices: [
						{ id: 1, label: '1/1 (whole)' },
						{ id: 2, label: '1/2 (half)' },
						{ id: 4, label: '1/4 (quarter)' },
						{ id: 8, label: '1/8 (eighth)' },
					],
				},
			],
			callback: ({ options }) => self.sendSet({ beatDivision: options.div }),
		},

		fixture_blackout: {
			name: 'Fixture Blackout',
			options: [
				{
					type: 'number',
					id: 'fixture',
					label: 'Fixture number (ID + 1)',
					default: 1,
					min: 1,
					max: Number.MAX_SAFE_INTEGER,
				},
				{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: MODE_TOGGLE },
			],
			callback: ({ options }) => {
				const fix = fixtureForNumber(options.fixture)
				if (!fix) return
				const cur = fix.override
				const next = options.mode === 'toggle' ? !cur?.blackout : options.mode === 'on'
				if (!next && cur?.blackout && !cur.enabled) {
					self.sendOverride(fix.id, null)
					return
				}
				self.sendOverride(fix.id, {
					...(cur || {
						enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0,
					}),
					blackout: next,
				})
			},
		},

		fixture_override: {
			name: 'Fixture Override (RGBWAUV)',
			options: [
				{
					type: 'number',
					id: 'fixture',
					label: 'Fixture number (ID + 1)',
					default: 1,
					min: 1,
					max: Number.MAX_SAFE_INTEGER,
				},
				{ type: 'colorpicker', id: 'rgb', label: 'RGB Colour', default: combineRgb(255, 0, 0) },
				{ type: 'number', id: 'white', label: 'White (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'amber', label: 'Amber (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'uv', label: 'UV (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'dim', label: 'Dimmer (0-255)', default: 255, min: 0, max: 255 },
			],
			callback: ({ options }) => {
				const rgb = options.rgb
				const fix = fixtureForNumber(options.fixture)
				if (!fix) return
				self.sendOverride(fix.id, {
					enabled: true,
					r: (rgb >> 16) & 0xff,
					g: (rgb >> 8) & 0xff,
					b: rgb & 0xff,
					w: options.white,
					a: options.amber,
					uv: options.uv,
					dim: options.dim,
					strobe: 0,
					blackout: false,
				})
			},
		},

		fixture_clear: {
			name: 'Clear Fixture Override',
			options: [
				{
					type: 'dropdown',
					id: 'fixture',
					label: 'Fixture',
					default: 'all',
					choices: [{ id: 'all', label: 'All fixtures' }, ...fixtureChoices],
				},
			],
			callback: ({ options }) => {
				if (options.fixture === 'all') {
					for (const fixture of fixturesOf(self.liveState)) self.sendOverride(fixture.id, null)
				} else {
					const fixture = fixtureForNumber(options.fixture)
					if (fixture) self.sendOverride(fixture.id, null)
				}
			},
		},

		energy_override: {
			name: 'Energy Override (latch on)',
			options: [
				{ type: 'dropdown', id: 'effect', label: 'Effect', default: 'white-strobe', choices: energyChoices },
			],
			callback: ({ options }) => self.sendSet({ energyOverride: options.effect }),
		},

		energy_override_off: {
			name: 'Energy Override Off',
			options: [],
			callback: () => self.sendSet({ energyOverride: null }),
		},

		// Momentary, the way a busking button wants it: on while the button is
		// down, gone the moment it comes up — and gone on its own within a
		// second and a bit if Companion crashes or the network drops with the
		// button down, so the rig can never be left strobing.
		energy_hold: {
			name: 'Energy Hold (press: on, release: off)',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Button',
					default: 'press',
					choices: [
						{ id: 'press', label: 'Press (put on the button\'s down)' },
						{ id: 'release', label: 'Release (put on the button\'s up)' },
					],
				},
				{
					type: 'dropdown',
					id: 'effect',
					label: 'Effect (for Press)',
					default: 'white-strobe',
					choices: energyChoices,
				},
			],
			callback: ({ options }) => {
				if (options.mode === 'release') self.releaseEnergy()
				else self.holdEnergy(options.effect)
			},
		},

		set_strobe_function: {
			name: 'Set Strobe Function',
			options: [
				{ type: 'dropdown', id: 'func', label: 'Function', default: 'standard', choices: choices(strobesOf(state)) },
			],
			callback: ({ options }) => self.sendSet({ strobeFunction: options.func }),
		},

		set_strobe_speed: {
			name: 'Set Strobe Speed',
			options: [{ type: 'number', id: 'speed', label: 'Speed (0-255)', default: 128, min: 0, max: 255 }],
			callback: ({ options }) => self.sendSet({ strobeSpeed: options.speed }),
		},

		// ── Cues and the auto show ──

		recall_cue: {
			name: 'Recall Cue',
			options: [
				{
					type: 'dropdown',
					id: 'cue',
					label: 'Cue',
					default: cueChoices[0]?.id ?? '',
					choices: cueChoices,
					allowCustom: true,
					tooltip: 'Cues are saved looks, stored in the server\'s Show view',
				},
			],
			callback: async ({ options }) => {
				if (options.cue) await self.recallCue(options.cue)
			},
		},

		auto_show: {
			name: 'Auto Show Start / Stop',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'start', label: 'Start' },
						{ id: 'stop', label: 'Stop' },
					],
				},
			],
			callback: async ({ options }) => {
				await self.autoShow(options.mode)
			},
		},

		auto_intensity: {
			name: 'Auto Show Intensity',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'set',
					choices: [
						{ id: 'set', label: 'Set to' },
						{ id: 'adjust', label: 'Adjust by' },
					],
				},
				{ type: 'number', id: 'value', label: 'Intensity (0-100, or ±)', default: 50, min: -100, max: 100 },
			],
			callback: ({ options }) => {
				const current = Number.isFinite(self.liveState.autoIntensity) ? self.liveState.autoIntensity : 50
				const next = options.mode === 'adjust' ? current + options.value : options.value
				self.sendSet({ autoIntensity: Math.max(0, Math.min(100, next)) })
			},
		},

		auto_source: {
			name: 'Auto Show Source',
			options: [{ type: 'dropdown', id: 'source', label: 'Follow', default: 'auto', choices: choices(AUTO_SOURCES) }],
			callback: ({ options }) => self.sendSet({ autoSource: options.source }),
		},

		nudge_sync: {
			name: 'Nudge Auto Show Sync',
			options: [
				{
					type: 'number',
					id: 'delta',
					label: 'Milliseconds (+ runs the lights earlier)',
					default: 20,
					min: -limit,
					max: limit,
				},
			],
			callback: ({ options }) => {
				const current = Number.isFinite(self.liveState.autoSyncOffsetMs) ? self.liveState.autoSyncOffsetMs : 0
				self.sendSet({ autoSyncOffsetMs: Math.max(-limit, Math.min(limit, Math.round(current + options.delta))) })
			},
		},
	}

	// One "set colour" action per palette slot (A-D; C/D drive 3- and 4-colour patterns)
	for (const slot of COLOR_SLOTS) {
		actions[slot.actionId] = {
			name: `Set Colour ${slot.label}`,
			options: [
				{
					type: 'dropdown',
					id: 'color',
					label: 'Colour',
					default: slot.defaultIndex,
					choices: colorChoices(state),
				},
			],
			callback: ({ options }) => self.sendSet({ [slot.id]: options.color }),
		}
	}

	self.setActionDefinitions(actions)
}
