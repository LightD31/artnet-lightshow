import { combineRgb } from '@companion-module/base'
import { COLOR_CHOICES, COLOR_SLOTS, ENERGY_CHOICES, FIXTURE_COUNT, PATTERN_CHOICES } from './constants.js'

export function UpdateFeedbacks(self) {
	const feedbacks = {
		pattern_active: {
			type: 'boolean',
			name: 'Pattern is active',
			defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'dropdown',
					id: 'pattern',
					label: 'Pattern',
					default: 'chase',
					choices: PATTERN_CHOICES,
				},
			],
			callback: ({ options }) => self.liveState.pattern === options.pattern,
		},

		blackout_active: {
			type: 'boolean',
			name: 'Master blackout active',
			defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => !!self.liveState.masterBlackout,
		},

		playing: {
			type: 'boolean',
			name: 'Show is playing',
			defaultStyle: { bgcolor: combineRgb(0, 180, 60), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => !!self.liveState.running,
		},

		fixture_blackout: {
			type: 'boolean',
			name: 'Fixture blackout active',
			defaultStyle: { bgcolor: combineRgb(180, 0, 0), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'number',
					id: 'fixture',
					label: `Fixture (1-${FIXTURE_COUNT})`,
					default: 1,
					min: 1,
					max: FIXTURE_COUNT,
				},
			],
			callback: ({ options }) => {
				const fix = self.liveState.fixtures && self.liveState.fixtures[options.fixture - 1]
				return !!(fix && fix.override && fix.override.blackout)
			},
		},

		fixture_override: {
			type: 'boolean',
			name: 'Fixture override active',
			defaultStyle: { bgcolor: combineRgb(255, 100, 0), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'number',
					id: 'fixture',
					label: `Fixture (1-${FIXTURE_COUNT})`,
					default: 1,
					min: 1,
					max: FIXTURE_COUNT,
				},
			],
			callback: ({ options }) => {
				const fix = self.liveState.fixtures && self.liveState.fixtures[options.fixture - 1]
				return !!(fix && fix.override && fix.override.enabled)
			},
		},

		energy_override_active: {
			type: 'boolean',
			name: 'Energy override active',
			defaultStyle: { bgcolor: combineRgb(255, 30, 30), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'dropdown',
					id: 'effect',
					label: 'Effect (or "any")',
					default: 'any',
					choices: [{ id: 'any', label: 'Any energy effect' }, ...ENERGY_CHOICES],
				},
			],
			callback: ({ options }) => {
				if (options.effect === 'any') return !!self.liveState.energyOverride
				return self.liveState.energyOverride === options.effect
			},
		},
	}

	// One "colour selected" feedback per palette slot (A-D)
	for (const slot of COLOR_SLOTS) {
		feedbacks[slot.feedbackId] = {
			type: 'boolean',
			name: `Colour ${slot.label} is selected`,
			defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'dropdown',
					id: 'color',
					label: 'Colour',
					default: slot.defaultIndex,
					choices: COLOR_CHOICES,
				},
			],
			callback: ({ options }) => self.liveState[slot.id] === options.color,
		}
	}

	self.setFeedbackDefinitions(feedbacks)
}
