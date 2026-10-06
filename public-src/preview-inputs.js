import { presetById } from '../src/shared/effects/catalogue.ts';

// What the stage preview hands createPreviewSampler beside the timeline, so a
// rehearsal shows what the rig plays over it: the voices held now (pads, the
// strobe, the matrix board), the playing sequence, the palette override and
// the live Hue strobe setting. Pure, so the wiring is unit-tested.

/** A pattern id's effect: a saved preset first, then the catalogue; null plays the pattern. */
export function resolverOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.spec).map((p) => [p.id, p.spec]));
  return (id) => mine.get(id) || presetById(id)?.spec || null;
}

/** The sampler's options for a live state; `table` is the loaded sequence's clip table. */
export function previewOptions(s, { table = null, saved = [] } = {}) {
  const seq = s.sequence;
  const override = Array.isArray(s.paletteOverride) && s.paletteOverride.length ? s.paletteOverride : null;
  return {
    resolveEffect: resolverOf(saved),
    // The rig's default; the sampler's own 'pulse' is for hand-built inputs only.
    hueStrobe: s.hueStrobe === 'pulse' ? 'pulse' : 'flash',
    safety: s.safety ? { acknowledged: !!s.safety.acknowledged, hdFlashIntervalMs: s.safety.hdFlashIntervalMs ?? 350 } : null,
    paletteOverride: override,
    // A playing sequence rehearses from the track's first beat.
    sequence: table && seq && seq.playing ? { table, transport: { startBeat: 0, loop: seq.loop ?? null, generation: 0 } } : null,
  };
}

/** The voices playing now as timeline voices from 0:00; hidden ones and any without an effect are left out. */
export function liveVoiceEvents(voices) {
  return (Array.isArray(voices) ? voices : []).filter((v) => v && !v.hidden && v.spec).map((v) => ({
    timeMs: 0, action: 'voice',
    data: { id: `live:${v.id}`, effect: v.spec, targets: v.targets, tier: v.tier === 'strobe' ? 'strobe' : 'voice', launchSeq: v.launchSeq },
  }));
}

/** One line: the look, the pads, the strobe, the matrix, where the sequence is, the override. */
export function nowPlaying(s) {
  const voices = (Array.isArray(s.voices) ? s.voices : []).filter((v) => !v.hidden);
  const pads = voices.filter((v) => v.tier !== 'strobe' && v.source !== 'matrix').map((v) => v.label);
  const parts = [s.pattern || 'No look'];
  if (pads.length) parts.push(`Pads: ${pads.join(', ')}`);
  if (s.strobe?.active || voices.some((v) => v.tier === 'strobe')) parts.push('Strobe');
  const colours = s.matrix && Array.isArray(s.matrix.colours) ? s.matrix.colours.length : 0;
  if (colours) parts.push(`Matrix: ${colours} colour${colours > 1 ? 's' : ''} as ${s.matrix.mode}`);
  const seq = s.sequence;
  if (seq && seq.playing && seq.loaded) parts.push(`${seq.loaded.name} bar ${seq.bar} beat ${Math.floor(seq.beat % 4) + 1}`);
  if (Array.isArray(s.paletteOverride) && s.paletteOverride.length) parts.push('Palette override');
  return parts.join(' · ');
}

const RAPID_BOARD = new Set(['fireworks', 'flashes', 'pulses']);

/** The board modes the server refuses (409) before the photosensitivity acknowledgement. */
export function matrixAsks(mode, acknowledged) {
  return RAPID_BOARD.has(mode) && !acknowledged;
}
