import { presetById } from '../src/shared/effects/catalogue.ts';
import { playingState } from './now-playing.js';

// What the stage preview hands createPreviewSampler beside the timeline, so a
// rehearsal shows what the rig plays over it: the voices held now (pads, the
// strobe, the matrix board), the playing sequence, the palette override and
// the live Hue strobe setting. Pure, so the wiring is unit-tested.

/** A pattern id's effect: a saved preset first, then the catalogue; null plays the pattern. */
export function resolverOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.spec).map((p) => [p.id, p.spec]));
  return (id) => mine.get(id) || presetById(id)?.spec || null;
}

/** Beats in a bar, in quarter notes: 6/8 is three. */
export function beatsPerBar(ts) {
  if (!ts || !(ts.beats > 0) || !(ts.unit > 0)) return 4;
  return (ts.beats * 4) / ts.unit;
}

/** "bar.beat", both counted from 1. The server's `bar` is already 1-based. */
export function positionText(status, perBar) {
  if (!status || !Number.isFinite(status.beat)) return '–';
  const bar = status.bar || Math.floor(status.beat / perBar) + 1;
  const inBar = Math.floor(status.beat - (bar - 1) * perBar + 1e-6) + 1;
  return `${bar}.${Math.min(Math.max(inBar, 1), Math.ceil(perBar))}`;
}

/**
 * The sampler's options for a live state; `table` is the loaded sequence's
 * clip table, `library` what GET /api/effects answered (its `user` presets
 * carry their specs; the live state's `effects` are summaries without).
 */
export function previewOptions(s, { table = null, library = null } = {}) {
  const seq = s.sequence;
  const override = Array.isArray(s.paletteOverride) && s.paletteOverride.length ? s.paletteOverride : null;
  return {
    resolveEffect: resolverOf(library && library.user),
    // The rig's default; the sampler's own 'pulse' is for hand-built inputs only.
    hueStrobe: s.hueStrobe === 'pulse' ? 'pulse' : 'flash',
    safety: s.safety ? { acknowledged: !!s.safety.photosensitivityAcknowledged, hdFlashIntervalMs: s.safety.hdFlashIntervalMs ?? 350 } : null,
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

export function nowPlaying(s, perBar = s.sequence?.beatsPerBar || 4) {
  const playing = playingState(s);
  const parts = [`Base: ${playing.base.name}${playing.base.running ? '' : ' (stopped)'}`];
  parts.push(...playing.layers.map((layer) => `${layer.target}: ${layer.name}`));
  const seq = playing.sequence;
  if (seq) {
    const state = { playing: 'playing', paused: 'paused', hold: 'holding frame', black: 'blackout', loaded: 'loaded' }[seq.mode];
    parts.push(`Sequence: ${seq.name || seq.id} (${state}) bar ${positionText(seq, perBar).replace('.', ' beat ')}`);
  }
  if (playing.voices.length) parts.push(`Voices: ${playing.voices.map((voice) => voice.label).join(', ')}`);
  if (playing.strobe && !playing.voices.some((voice) => voice.tier === 'strobe')) parts.push('Strobe');
  if (playing.matrix && !playing.voices.some((voice) => voice.source === 'matrix')) {
    const count = playing.matrix.colours.length;
    parts.push(`Matrix: ${count} colour${count > 1 ? 's' : ''} as ${playing.matrix.mode}`);
  }
  if (playing.override) parts.push('Palette override');
  return parts.join(' · ');
}

const RAPID_BOARD = new Set(['fireworks', 'flashes', 'pulses']);

/** The board modes the server refuses (409) before the photosensitivity acknowledgement. */
export function matrixAsks(mode, acknowledged) {
  return RAPID_BOARD.has(mode) && !acknowledged;
}
