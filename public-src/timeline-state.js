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

/** Return the musical and lighting context nearest an operator's pointer. */
export function timelineDetails(data, positionMs, windowMs = 400) {
  if (!data || !Number.isFinite(data.duration) || data.duration <= 0) {
    return { positionMs: 0, percent: 0, section: null, events: [] };
  }
  const durationMs = data.duration * 1000;
  const position = Math.max(0, Math.min(durationMs, Number(positionMs) || 0));
  const segment = (data.segments || []).find((candidate) => {
    const start = Number(candidate.start) * 1000;
    const end = Number(candidate.end) * 1000;
    return Number.isFinite(start) && Number.isFinite(end) && position >= start && position <= end;
  });
  const events = (data.timeline || [])
    .filter((event) => Number.isFinite(event.timeMs) && Math.abs(event.timeMs - position) <= windowMs)
    .slice(0, 5)
    .map((event) => ({
      timeMs: event.timeMs,
      label: event.action === 'energy'
        ? `${event.id || 'Energy'} burst`
        : event.pattern ? `Pattern: ${event.pattern}`
          : event.colorA != null ? 'Colour change' : 'Look update',
    }));
  return {
    positionMs: position,
    percent: (position / durationMs) * 100,
    section: segment ? (segment.role || segment.label || 'Section') : null,
    events,
  };
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
