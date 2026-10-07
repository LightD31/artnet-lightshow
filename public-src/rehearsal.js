import { useEffect, useMemo, useState } from 'preact/hooks';
import { stagePreviewSig, stateSig, librarySig, api } from './state.js';
import { createPreviewSampler } from '../src/shared/preview.ts';
import { liveVoiceEvents, previewOptions } from './preview-inputs.js';

// Track identity resets rehearsal; remounting a view must not rewind it.
export function useRehearsalTrack(autoShow) {
  const t = autoShow && autoShow.track;
  const trackId = t ? `${t.id ?? ''}|${t.name ?? ''}|${t.artist ?? ''}` : null;
  useEffect(() => {
    if (stagePreviewSig.value.trackId === trackId) return;
    stagePreviewSig.value = { ...stagePreviewSig.value, playing: false, position: 0, rehearsal: false, trackId };
  }, [trackId]);
}

export function useRehearsalSampler(data) {
  const s = stateSig.value;
  const revision = s.sequence ? s.sequence.revision : null;
  const [table, setTable] = useState(null);
  // Only the latest table load may land so overlapping requests cannot restore a stale revision.
  useEffect(() => {
    let live = true;
    api('/api/sequence').then((r) => { if (live) setTable((r && r.ok && r.table) || null); });
    return () => { live = false; };
  }, [revision]);
  const options = previewOptions(s, { table, library: librarySig.value });
  const key = JSON.stringify([s.voices, options.hueStrobe, options.paletteOverride, options.safety, options.sequence && options.sequence.table.revision, librarySig.value.user]);
  return useMemo(() => createPreviewSampler([...(data?.timeline || []), ...liveVoiceEvents(s.voices)], data, options), [data, key]);
}
