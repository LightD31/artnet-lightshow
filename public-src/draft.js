import { useEffect, useMemo, useReducer } from 'preact/hooks';

// Keep local drafts until acknowledged so delayed server echoes cannot move a dragged thumb.

export const SETTLE_MS = 600;

const nextFrame = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

export function createFrameThrottle(send, schedule = nextFrame) {
  let pending;
  let has = false;
  let scheduled = false;
  const fire = () => {
    scheduled = false;
    if (!has) return;
    has = false;
    const value = pending;
    pending = undefined;
    send(value);
  };
  return {
    push(value) {
      pending = value;
      has = true;
      if (!scheduled) {
        scheduled = true;
        schedule(fire);
      }
    },
    flush() {
      if (has) fire();
    },
    cancel() {
      has = false;
      pending = undefined;
    },
  };
}

export function createDraft({ send, schedule = nextFrame, now = () => Date.now(), settleMs = SETTLE_MS, onChange = () => {} }) {
  const throttle = createFrameThrottle(send, schedule);
  let draft;
  let active = false;
  let settleUntil = 0;
  let lastSent;

  const clear = () => {
    if (draft === undefined) return;
    draft = undefined;
    onChange();
  };

  return {
    value(server) {
      if (draft !== undefined && !active && now() > settleUntil) draft = undefined;
      return draft !== undefined ? draft : server;
    },
    input(value) {
      active = true;
      draft = value;
      lastSent = value;
      throttle.push(value);
      onChange();
    },
    commit(value = draft) {
      if (value === undefined) return;
      throttle.cancel();
      // Resend the release value because the server may have refused an earlier frame.
      send(value);
      lastSent = value;
      draft = value;
      active = false;
      settleUntil = now() + settleMs;
      onChange();
    },
    observe(server) {
      if (active || draft === undefined) return;
      if (server === lastSent || now() > settleUntil) clear();
    },
    get active() { return active; },
    get settling() { return !active && draft !== undefined; },
  };
}

export function useDraft(server, send) {
  const [, rerender] = useReducer((n) => n + 1, 0);
  const holder = useMemo(() => ({ send }), []);
  holder.send = send;
  const draft = useMemo(() => createDraft({
    send: (v) => holder.send(v),
    onChange: rerender,
  }), []);
  useEffect(() => { draft.observe(server); }, [server]);
  // A released draft the server never confirmed still has to give way.
  const settling = draft.settling;
  useEffect(() => {
    if (!settling) return undefined;
    const timer = setTimeout(() => { draft.observe(server); rerender(); }, SETTLE_MS + 20);
    return () => clearTimeout(timer);
  }, [settling, server]);
  return [draft.value(server), (v) => draft.input(v), (v) => draft.commit(v)];
}
