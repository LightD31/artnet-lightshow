import {
	slotColorName,
	energyName,
	paletteName,
	patternName,
	pixelMapName,
	sourceName,
	strobeName,
} from './constants.js'

const CLOCK_LABELS = { auto: 'Auto', cdj: 'CDJ', track: 'Track', tap: 'Tap' }

export function UpdateVariableDefinitions(self) {
	self.setVariableDefinitions({
		bpm: { name: 'Current BPM' },
		clock_source: { name: 'What the patterns keep time by (Auto, CDJ, Track or Tap)' },
		beat_division: { name: 'Beat division' },
		playing: { name: 'Show is playing (true/false)' },
		outputs_armed: { name: 'Outputs armed — anything leaves the machine (true/false)' },
		pattern: { name: 'Active pattern name' },
		pattern_id: { name: 'Active pattern id' },
		pixel_pattern: { name: 'The LED bars\' own pattern (or "none")' },
		panel_pattern: { name: 'The panels\' own pattern (or "none")' },
		pixel_map: { name: 'How pixel effects are laid over the rig' },
		palette: { name: 'Active palette name (or "custom")' },
		palette_override: { name: 'Palette over every effect (or "off")' },
		color_a: { name: 'Colour A name' },
		color_b: { name: 'Colour B name' },
		color_c: { name: 'Colour C name' },
		color_d: { name: 'Colour D name' },
		master_dimmer: { name: 'Master dimmer (0-255)' },
		master_dimmer_pct: { name: 'Master dimmer (0-100 %)' },
		master_blackout: { name: 'Master blackout (true/false)' },
		strobe_function: { name: 'Strobe function name' },
		strobe_speed: { name: 'Strobe speed (0-255)' },
		energy_override: { name: 'Active energy override (or "off")' },
		...padVariableDefinitions(),
		auto_show: { name: 'Auto show running (true/false)' },
		auto_source: { name: 'What the auto show follows now' },
		auto_intensity: { name: 'Auto show intensity (0-100)' },
		sync_offset: { name: 'Auto show sync offset (ms)' },
		track: { name: 'The track playing (Artist — Title)' },
		cue_count: { name: 'Number of saved cues' },
	})
}

export function UpdateVariableValues(self) {
	const s = self.liveState
	const track = (s.autoShow && s.autoShow.track) || (s.nowPlaying && s.nowPlaying.name ? s.nowPlaying : null)
	self.setVariableValues({
		// To a tenth: the rig keeps a hundredth, which is more than a button can show.
		bpm: Number.isFinite(s.bpm) ? Math.round(s.bpm * 10) / 10 : s.bpm,
		clock_source: CLOCK_LABELS[s.clock && s.clock.source] || 'Tap',
		beat_division: s.beatDivision,
		playing: !!s.running,
		outputs_armed: !!s.armed,
		pattern: patternName(s, s.pattern),
		pattern_id: s.pattern,
		pixel_pattern: s.pixelPattern ? patternName(s, s.pixelPattern) : 'none',
		panel_pattern: s.panelPattern ? patternName(s, s.panelPattern) : 'none',
		pixel_map: pixelMapName(s.pixelMap || 'stage'),
		palette: s.palette ? paletteName(s, s.palette) : 'custom',
		palette_override: s.paletteOverrideId ? paletteName(s, s.paletteOverrideId) : s.paletteOverride ? 'custom' : 'off',
		color_a: slotColorName(s, 'colorA'),
		color_b: slotColorName(s, 'colorB'),
		color_c: slotColorName(s, 'colorC'),
		color_d: slotColorName(s, 'colorD'),
		master_dimmer: s.masterDimmer,
		master_dimmer_pct: Number.isFinite(s.masterDimmer) ? Math.round((s.masterDimmer / 255) * 100) : undefined,
		master_blackout: !!s.masterBlackout,
		strobe_function: strobeName(s, s.strobeFunction),
		strobe_speed: s.strobeSpeed,
		energy_override: s.energyOverride ? energyName(s, s.energyOverride) : 'off',
		auto_show: !!(s.showOn || (s.autoShow && s.autoShow.running)),
		auto_source: s.activeSource ? sourceName(s.activeSource) : '—',
		auto_intensity: s.autoIntensity,
		sync_offset: s.autoSyncOffsetMs,
		track: track && track.name ? `${track.artist ? `${track.artist} — ` : ''}${track.name}` : '—',
		cue_count: Array.isArray(s.cues) ? s.cues.length : 0,
		...padLabels(s),
	})
}

// The deck's 16 pads, numbered 1-16 across both banks as the presets are.
export const PAD_COUNT = 16

function padVariableDefinitions() {
	const defs = {}
	for (let n = 1; n <= PAD_COUNT; n++) defs[`pad_${n}_label`] = { name: `Pad ${n} label` }
	return defs
}

function padLabels(s) {
	const layout = (s.pads && Array.isArray(s.pads.layout) && s.pads.layout) || []
	const values = {}
	for (let n = 1; n <= PAD_COUNT; n++) {
		const pad = layout.find((p) => p && p.bank * 8 + p.slot === n - 1)
		values[`pad_${n}_label`] = (pad && pad.label) || ''
	}
	return values
}
