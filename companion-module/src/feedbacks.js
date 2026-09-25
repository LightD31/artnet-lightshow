import { combineRgb } from '@companion-module/base'
import {
	AUTO_SOURCES,
	COLOR_SLOTS,
	PIXEL_MAPS,
	choices,
	colorChoices,
	energyOf,
	fixturesOf,
	palettesOf,
	patternsOf,
} from './constants.js'

const WHITE = combineRgb(255, 255, 255)

export function UpdateFeedbacks(self) {
	const state = self.liveState
	const fixtureNumber = {
		type: 'number',
		id: 'fixture',
		label: 'Fixture number (ID + 1)',
		default: 1,
		min: 1,
		max: Number.MAX_SAFE_INTEGER,
	}
	const fixtureFor = (number) => fixturesOf(self.liveState).find((fixture) => fixture.id === Number(number) - 1)

	const feedbacks = {
		pattern_active: {
			type: 'boolean',
			name: 'Pattern is active',
			defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: WHITE },
			options: [{ type: 'dropdown', id: 'pattern', label: 'Pattern', default: 'chase', choices: choices(patternsOf(state)) }],
			callback: ({ options }) => self.liveState.pattern === options.pattern,
		},

		pixel_pattern_active: {
			type: 'boolean',
			name: 'Bars pattern is active',
			defaultStyle: { bgcolor: combineRgb(0, 120, 200), color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'pattern',
					label: 'Pixel effect',
					default: 'none',
					choices: [{ id: 'none', label: 'None' }, ...choices(patternsOf(state).filter((p) => p.pixel))],
				},
			],
			callback: ({ options }) => (self.liveState.pixelPattern ?? 'none') === options.pattern,
		},

		pixel_map_active: {
			type: 'boolean',
			name: 'Pixel map is active',
			defaultStyle: { bgcolor: combineRgb(0, 120, 200), color: WHITE },
			options: [{ type: 'dropdown', id: 'map', label: 'Map', default: 'stage', choices: choices(PIXEL_MAPS) }],
			callback: ({ options }) => (self.liveState.pixelMap || 'stage') === options.map,
		},

		palette_active: {
			type: 'boolean',
			name: 'Palette is active',
			defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'palette',
					label: 'Palette',
					default: palettesOf(state)[0]?.id ?? '',
					choices: choices(palettesOf(state)),
					allowCustom: true,
				},
			],
			callback: ({ options }) => self.liveState.palette === options.palette,
		},

		blackout_active: {
			type: 'boolean',
			name: 'Master blackout active',
			defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: WHITE },
			options: [],
			callback: () => !!self.liveState.masterBlackout,
		},

		playing: {
			type: 'boolean',
			name: 'Show is playing',
			defaultStyle: { bgcolor: combineRgb(0, 180, 60), color: WHITE },
			options: [],
			callback: () => !!self.liveState.running,
		},

		auto_show_on: {
			type: 'boolean',
			name: 'Auto show is running',
			defaultStyle: { bgcolor: combineRgb(0, 160, 120), color: WHITE },
			options: [],
			callback: () => !!(self.liveState.showOn || self.liveState.autoShow?.running),
		},

		source_active: {
			type: 'boolean',
			name: 'Auto show follows this source',
			defaultStyle: { bgcolor: combineRgb(0, 110, 160), color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'source',
					label: 'Source',
					default: 'prolink',
					choices: choices(AUTO_SOURCES.filter((s) => s.id !== 'auto')),
				},
			],
			callback: ({ options }) => self.liveState.activeSource === options.source,
		},

		fixture_blackout: {
			type: 'boolean',
			name: 'Fixture blackout active',
			defaultStyle: { bgcolor: combineRgb(180, 0, 0), color: WHITE },
			options: [fixtureNumber],
			callback: ({ options }) => {
				const fix = fixtureFor(options.fixture)
				return !!(fix && fix.override && fix.override.blackout)
			},
		},

		fixture_override: {
			type: 'boolean',
			name: 'Fixture override active',
			defaultStyle: { bgcolor: combineRgb(255, 100, 0), color: WHITE },
			options: [fixtureNumber],
			callback: ({ options }) => {
				const fix = fixtureFor(options.fixture)
				return !!(fix && fix.override && fix.override.enabled)
			},
		},

		energy_override_active: {
			type: 'boolean',
			name: 'Energy override active (latched or held)',
			defaultStyle: { bgcolor: combineRgb(255, 30, 30), color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'effect',
					label: 'Effect (or "any")',
					default: 'any',
					choices: [{ id: 'any', label: 'Any energy effect' }, ...choices(energyOf(state))],
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
			defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'color',
					label: 'Colour',
					default: slot.defaultIndex,
					choices: colorChoices(state),
				},
			],
			callback: ({ options }) => self.liveState[slot.id] === options.color,
		}
	}

	self.setFeedbackDefinitions(feedbacks)
}
