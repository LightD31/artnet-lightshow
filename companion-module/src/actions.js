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
	const fixtureForNumber = (number) => self.liveState.fixtures?.find((fixture) => fixture.id === Number(number) - 1)
	const fixtureChoices = self.liveState.fixtures
		? self.liveState.fixtures.map((fixture) => ({ id: fixture.id + 1, label: `${fixture.id + 1}: ${fixture.label}` }))
		: Array.from({ length: FIXTURE_COUNT }, (_, i) => ({ id: i + 1, label: `PAR ${i + 1}` }))
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
					label: 'Fixture number (ID + 1)',
					default: 1,
					min: 1,
					max: Number.MAX_SAFE_INTEGER,
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
					choices: [
						{ id: 'all', label: 'All fixtures' },
						...fixtureChoices,
					],
				},
			],
			callback: ({ options }) => {
				if (options.fixture === 'all') {
					for (const fixture of self.liveState.fixtures || []) self.sendOverride(fixture.id, null)
				} else {
					const fixture = fixtureForNumber(options.fixture)
					if (fixture) self.sendOverride(fixture.id, null)
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
