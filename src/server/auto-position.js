'use strict';

// Keep the last stopped position, and distinguish an armed show from a source
// whose clock is actually moving. This works for every position provider,
// including paused players and a PRO DJ LINK clock frozen after lost packets.
function sampleAutoPosition(show, previous = {}) {
  const revision = show.timelineRevision;
  const sameTimeline = previous.revision === revision;
  const fallback = sameTimeline && Number.isFinite(previous.positionMs) ? previous.positionMs : 0;
  const raw = show.running ? show.getPositionMs() : fallback;
  const positionMs = Number.isFinite(raw) ? raw : fallback;
  const delta = positionMs - previous.positionMs;
  return {
    positionMs,
    running: !!show.running,
    advancing: !!show.running && Number.isFinite(raw) && sameTimeline && delta > 0 && delta < 1500,
    revision,
  };
}

module.exports = { sampleAutoPosition };
