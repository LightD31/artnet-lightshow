import { useEffect, useMemo, useState } from 'preact/hooks';
import { stagePreviewSig, stateSig, librarySig, api } from './state.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { liveVoiceEvents, previewOptions } from './preview-inputs.js';

/**
 * Rehearsal belongs to a track. When the loaded track changes, whatever was
 * being rehearsed stops and rewinds — but a view switch that remounts a
 * panel is not a new track, so it is compared with the track the rehearsal
 * was started on (kept beside it) rather than reset on every mount. Shared by
 * the stage preview and the 3D stage, which rehearse the same position.
 */
export function useRehearsalTrack(autoShow) {
  const t = autoShow && autoShow.track;
  const trackId = t ? `${t.id ?? ''}|${t.name ?? ''}|${t.artist ?? ''}` : null;
  useEffect(() => {
    if (stagePreviewSig.value.trackId === trackId) return;
    stagePreviewSig.value = { ...stagePreviewSig.value, playing: false, position: 0, rehearsal: false, trackId };
  }, [trackId]);
}

/**
 * The rehearsal's sampler: the timeline with what the rig plays over it now
 * (voices, the playing sequence, the override, the live Hue strobe setting).
 */
export function useRehearsalSampler(data) {
  const s = stateSig.value;
  const revision = s.sequence ? s.sequence.revision : null;
  const [table, setTable] = useState(null);
  // The clip table rides GET /api/sequence; refetched when its revision moves.
  // Only the latest of overlapping loads lands.
  useEffect(() => {
    let live = true;
    api('/api/sequence').then((r) => { if (live) setTable((r && r.ok && r.table) || null); });
    return () => { live = false; };
  }, [revision]);
  const options = previewOptions(s, { table, library: librarySig.value });
  const key = JSON.stringify([s.voices, options.hueStrobe, options.hardware, options.profiles, options.paletteOverride, options.basePalette, options.overridePalette, options.safety, options.sequence && options.sequence.table.revision, librarySig.value.user]);
  return useMemo(() => createPreviewSampler([...(data?.timeline || []), ...liveVoiceEvents(s.voices)], data, options), [data, key]);
}
