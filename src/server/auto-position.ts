// Keep the last stopped position, and distinguish an armed show from a source
// whose clock is actually moving. This works for every position provider,
// including paused players and a PRO DJ LINK clock frozen after lost packets.
/** What the auto show says about where it is. */
export interface PositionSource {
  timelineRevision: number;
  running: boolean;
  getPositionMs(): number;
}

export interface AutoPosition {
  positionMs: number;
  running: boolean;
  /** The clock is really moving, not armed on a paused source. */
  advancing: boolean;
  revision: number;
}

function sampleAutoPosition(show: PositionSource, previous: Partial<AutoPosition> = {}): AutoPosition {
  const revision = show.timelineRevision;
  const sameTimeline = previous.revision === revision;
  const fallback = sameTimeline && typeof previous.positionMs === 'number' && Number.isFinite(previous.positionMs)
    ? previous.positionMs : 0;
  const raw = show.running ? show.getPositionMs() : fallback;
  const positionMs = Number.isFinite(raw) ? raw : fallback;
  const delta = positionMs - (previous.positionMs as number);
  return {
    positionMs,
    running: !!show.running,
    advancing: !!show.running && Number.isFinite(raw) && sameTimeline && delta > 0 && delta < 1500,
    revision,
  };
}

export {
  sampleAutoPosition,
};
