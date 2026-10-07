import { presetById } from '../src/shared/effects/catalogue.ts';

export const NOW_PLAYING_FIELDS = ['pattern', 'patterns', 'effects', 'running', 'sequence', 'voices', 'strobe', 'matrix', 'paletteOverride', 'pixelPattern', 'panelPattern', 'fixtures', 'profiles'];

export function effectName(id, s = {}) {
  return (s.effects || []).find((row) => row.id === id)?.name
    || (s.patterns || []).find((row) => row.id === id)?.name
    || presetById(id)?.name || id || 'No look';
}

export function padLabel(pad, s = {}) {
  if (pad.label?.trim()) return pad.label.trim();
  const content = pad.content;
  if (!content) return 'Empty';
  if (content.kind === 'strobe') return 'Strobe';
  if (content.kind === 'pattern' || content.kind === 'sequencePattern') {
    return (s.sequencePatterns || []).find((row) => row.id === content.id)?.name || content.id;
  }
  return effectName(content.id, s);
}

export function playingState(s) {
  const seq = s.sequence;
  const sequence = seq?.loaded ? {
    ...seq.loaded,
    mode: seq.paused ? 'paused' : seq.playing ? 'playing' : seq.stopped || (seq.ended ? 'ended' : 'loaded'),
    beat: seq.beat, bar: seq.bar, beatsPerBar: seq.beatsPerBar || 4,
    activeClips: seq.activeClips || [],
  } : null;
  const pixels = (s.fixtures || []).map((fixture) => s.profiles?.[fixture.profileId]).filter((profile) => profile?.cells?.length >= 2);
  const layers = [
    pixels.length && s.pixelPattern ? { target: 'Bars', id: s.pixelPattern } : null,
    pixels.some((profile) => profile.grid && !profile.zoned) && s.panelPattern ? { target: 'Panels', id: s.panelPattern } : null,
  ].filter(Boolean).map((layer) => ({ ...layer, name: effectName(layer.id, s) }));
  return {
    layers,
    base: { id: s.pattern || null, name: effectName(s.pattern, s), running: s.running !== false },
    sequence,
    voices: (s.voices || []).filter((voice) => !voice.hidden).map((voice) => ({ ...voice, label: voice.label?.trim() || effectName(voice.kind || voice.id, s) })),
    strobe: !!s.strobe?.active,
    matrix: s.matrix?.colours?.length ? s.matrix : null,
    override: Array.isArray(s.paletteOverride) && s.paletteOverride.length > 0,
  };
}
