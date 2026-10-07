import { presetById } from '../src/shared/effects/catalogue.ts';
import { playingState } from './now-playing.js';


export function resolverOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.spec).map((p) => [p.id, p.spec]));
  return (id) => mine.get(id) || presetById(id)?.spec || null;
}

export function presetNameOf(saved = []) {
  const mine = new Map((Array.isArray(saved) ? saved : []).filter((p) => p && p.id && p.name).map((p) => [p.id, p.name]));
  return (id) => mine.get(id) || presetById(id)?.name || id;
}

export function beatsPerBar(ts) {
  if (!ts || !(ts.beats > 0) || !(ts.unit > 0)) return 4;
  return (ts.beats * 4) / ts.unit;
}

export function positionText(status, perBar) {
  if (!status || !Number.isFinite(status.beat)) return '–';
  const bar = status.bar || Math.floor(status.beat / perBar) + 1;
  const inBar = Math.floor(status.beat - (bar - 1) * perBar + 1e-6) + 1;
  return `${bar}.${Math.min(Math.max(inBar, 1), Math.ceil(perBar))}`;
}

export function previewOptions(s, { table = null, library = null } = {}) {
  const seq = s.sequence;
  const override = Array.isArray(s.paletteOverride) && s.paletteOverride.length ? s.paletteOverride : null;
  return {
    resolveEffect: resolverOf(library && library.user),
    hueStrobe: s.hueStrobe === 'pulse' ? 'pulse' : 'flash',
    safety: s.safety ? { acknowledged: !!s.safety.photosensitivityAcknowledged, hdFlashIntervalMs: s.safety.hdFlashIntervalMs ?? 350 } : null,
    paletteOverride: override,
    basePalette: s.basePalette ?? null,
    overridePalette: s.overridePalette ?? null,
    sequence: table && seq && seq.playing ? { table, transport: { startBeat: 0, loop: seq.loop ?? null, generation: 0 } } : null,
  };
}

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
    const state = { playing: 'playing', paused: 'paused', hold: 'holding frame', black: 'blackout', ended: 'ended', loaded: 'loaded' }[seq.mode];
    parts.push(`Sequence: ${seq.name || seq.id} (${state}) bar ${positionText(seq, perBar).replace('.', ' beat ')}`);
    if (seq.activeClips.length) parts.push(`Clips: ${seq.activeClips.map((clip) => `${clip.lane}: ${clip.name}`).join(', ')}`);
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

export function matrixAsks(mode, acknowledged) {
  return RAPID_BOARD.has(mode) && !acknowledged;
}
