import { combineRgb } from '@companion-module/base'
import {
	COLOR_CHOICES,
	COLOR_SLOTS,
	ENERGY_CHOICES,
	FIXTURE_COUNT,
	PATTERN_CHOICES,
	STROBE_CHOICES,
} from './constants.js'

export function UpdateActions(self) {
	const actions = {
		set_pattern: {
			name: 'Set Pattern',
			options: [
				{
					type: 'dropdown',
					id: 'pattern',
					label: 'Pattern',
					default: 'chase',
					choices: PATTERN_CHOICES,
				},
			],
			callback: ({ options }) => self.sendSet({ pattern: options.pattern }),
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
				self.sendSet({ bpm: Math.max(20, Math.min(300, current + options.delta)) })
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

		master_blackout: {
			name: 'Master Blackout',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
				},
			],
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
					label: `Fixture (1-${FIXTURE_COUNT})`,
					default: 1,
					min: 1,
					max: FIXTURE_COUNT,
				},
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
				},
			],
			callback: ({ options }) => {
				const id = options.fixture - 1
				const fix = self.liveState.fixtures && self.liveState.fixtures[id]
				const cur = fix && fix.override && fix.override.blackout
				const next = options.mode === 'toggle' ? !cur : options.mode === 'on'
				self.sendOverride(id, { enabled: true, r: 0, g: 0, b: 0, w: 0, dim: 0, strobe: 0, blackout: next })
			},
		},

		fixture_override: {
			name: 'Fixture Override (RGBWAUV)',
			options: [
				{
					type: 'number',
					id: 'fixture',
					label: `Fixture (1-${FIXTURE_COUNT})`,
					default: 1,
					min: 1,
					max: FIXTURE_COUNT,
				},
				{ type: 'colorpicker', id: 'rgb', label: 'RGB Colour', default: combineRgb(255, 0, 0) },
				{ type: 'number', id: 'white', label: 'White (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'amber', label: 'Amber (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'uv', label: 'UV (0-255)', default: 0, min: 0, max: 255 },
				{ type: 'number', id: 'dim', label: 'Dimmer (0-255)', default: 255, min: 0, max: 255 },
			],
			callback: ({ options }) => {
				const rgb = options.rgb
				self.sendOverride(options.fixture - 1, {
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
					choices: [
						{ id: 'all', label: 'All fixtures' },
						...Array.from({ length: FIXTURE_COUNT }, (_, i) => ({ id: i + 1, label: `PAR ${i + 1}` })),
					],
				},
			],
			callback: ({ options }) => {
				if (options.fixture === 'all') {
					for (let i = 0; i < FIXTURE_COUNT; i++) self.sendOverride(i, null)
				} else {
					self.sendOverride(options.fixture - 1, null)
				}
			},
		},

		energy_override: {
			name: 'Energy Override (activate)',
			options: [
				{
					type: 'dropdown',
					id: 'effect',
					label: 'Effect',
					default: 'white-strobe',
					choices: ENERGY_CHOICES,
				},
			],
			callback: ({ options }) => self.sendSet({ energyOverride: options.effect }),
		},

		energy_override_off: {
			name: 'Energy Override Off',
			options: [],
			callback: () => self.sendSet({ energyOverride: null }),
		},

		set_strobe_function: {
			name: 'Set Strobe Function',
			options: [
				{
					type: 'dropdown',
					id: 'func',
					label: 'Function',
					default: 'standard',
					choices: STROBE_CHOICES,
				},
			],
			callback: ({ options }) => self.sendSet({ strobeFunction: options.func }),
		},

		set_strobe_speed: {
			name: 'Set Strobe Speed',
			options: [{ type: 'number', id: 'speed', label: 'Speed (0-255)', default: 128, min: 0, max: 255 }],
			callback: ({ options }) => self.sendSet({ strobeSpeed: options.speed }),
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
					choices: COLOR_CHOICES,
				},
			],
			callback: ({ options }) => self.sendSet({ [slot.id]: options.color }),
		}
	}

	self.setActionDefinitions(actions)
}
