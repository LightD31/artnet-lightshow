export function timelineKey(state) {
  const show = state.autoShow;
  if (!show?.analysis) return null;
  return show.timelineRevision ?? JSON.stringify([
    show.track?.name, show.track?.artist, show.timelineLength, show.analysis.duration,
    show.intensity, show.palette,
  ]);
}

export function timelinePosition(position, now, durationMs) {
  const base = Number.isFinite(position.positionMs) ? position.positionMs : 0;
  const advancing = position.running && (position.advancing ?? true);
  const elapsed = advancing && Number.isFinite(position.updatedAt)
    ? Math.max(0, Math.min(250, now - position.updatedAt)) : 0;
  const end = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Infinity;
  return Math.max(0, Math.min(end, base + elapsed));
}

// A request owns its result until cancelled. Aborting alone is insufficient:
// an already-resolved response can still finish parsing after a track change.
export function loadTimeline(key, publish, { fetcher = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    controller.abort();
    publish({ key, data: null, status: 'error', error: 'Timeline request timed out.' });
  }, timeoutMs);

  publish({ key, data: null, status: 'loading', error: null });
  const done = (async () => {
    try {
      const response = await fetcher('/api/auto/timeline', { signal: controller.signal });
      if (!response.ok) throw new Error('Could not load the timeline.');
      const body = await response.json();
      if (!body.ok || !body.data) throw new Error('The timeline is not available yet.');
      if (body.data.revision != null && body.data.revision !== key) {
        throw new Error('The show changed while loading. Retry to refresh.');
      }
      if (active) publish({ key, data: body.data, status: 'ready', error: null });
    } catch (err) {
      if (active) publish({ key, data: null, status: 'error', error: err.message || 'Could not load the timeline.' });
    } finally {
      clearTimeout(timer);
    }
  })();

  return {
    done,
    cancel() {
      active = false;
      clearTimeout(timer);
      controller.abort();
    },
  };
}
