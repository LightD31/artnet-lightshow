import { useEffect } from 'preact/hooks';
import { stagePreviewSig } from './state.js';

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
