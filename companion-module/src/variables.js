import { colorName, energyName, patternName, strobeName } from './constants.js'

export function UpdateVariableDefinitions(self) {
	self.setVariableDefinitions({
		bpm: { name: 'Current BPM' },
		beat_division: { name: 'Beat division' },
		playing: { name: 'Show is playing (true/false)' },
		pattern: { name: 'Active pattern name' },
		pattern_id: { name: 'Active pattern id' },
		color_a: { name: 'Colour A name' },
		color_b: { name: 'Colour B name' },
		color_c: { name: 'Colour C name' },
		color_d: { name: 'Colour D name' },
		master_dimmer: { name: 'Master dimmer (0-255)' },
		master_blackout: { name: 'Master blackout (true/false)' },
		strobe_function: { name: 'Strobe function name' },
		strobe_speed: { name: 'Strobe speed (0-255)' },
		energy_override: { name: 'Active energy override (or "off")' },
	})
}

export function UpdateVariableValues(self) {
	const s = self.liveState
	self.setVariableValues({
		bpm: s.bpm,
		beat_division: s.beatDivision,
		playing: !!s.running,
		pattern: patternName(s.pattern),
		pattern_id: s.pattern,
		color_a: colorName(s.colorA),
		color_b: colorName(s.colorB),
		color_c: colorName(s.colorC),
		color_d: colorName(s.colorD),
		master_dimmer: s.masterDimmer,
		master_blackout: !!s.masterBlackout,
		strobe_function: strobeName(s.strobeFunction),
		strobe_speed: s.strobeSpeed,
		energy_override: s.energyOverride ? energyName(s.energyOverride) : 'off',
	})
}
