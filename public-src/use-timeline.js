import { useEffect, useState } from 'preact/hooks';
import { autoTimelineSig, connectedSig, field } from './state.js';
import { loadTimeline, timelineKey } from './timeline-state.js';

/**
 * The loaded track's planned timeline — sections, curves, every event — for
 * whichever views want it: the Auto Show view's timeline, the Timeline view,
 * the stage's rehearsal. Fetched once per show revision however many of them
 * are open, kept while the connection drops, and fetched again on `retry`.
 */

let request = null;

function ensure(key, connected, force) {
  const now = autoTimelineSig.value;
  if (!key) {
    if (request) { request.cancel(); request = null; }
    if (now.key !== null) autoTimelineSig.value = { data: null, key: null, status: 'idle', error: null };
    return;
  }
  // Offline: what is loaded for this show stays; nothing new can be asked for.
  if (!connected) {
    if (now.key !== key || now.status !== 'ready') autoTimelineSig.value = { key, data: null, status: 'offline', error: null };
    return;
  }
  if (!force && now.key === key && (now.status === 'ready' || now.status === 'loading')) return;
  if (request) request.cancel();
  request = loadTimeline(key, (next) => {
    if (next.status !== 'loading' && autoTimelineSig.value.key !== key) return;
    autoTimelineSig.value = next;
  });
}

export function useTimeline() {
  const autoShow = field('autoShow').value;
  const key = timelineKey({ autoShow });
  const connected = connectedSig.value;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { ensure(key, connected, attempt > 0); }, [key, connected, attempt]);
  const t = autoTimelineSig.value;
  const mine = t.key === key;
  return {
    key,
    data: mine ? t.data : null,
    status: mine ? t.status : 'idle',
    error: mine ? t.error : null,
    retry: () => setAttempt((n) => n + 1),
  };
}
