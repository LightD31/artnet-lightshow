import { useEffect, useMemo, useReducer } from 'preact/hooks';

/**
 * Sliders that do not fight the hand moving them.
 *
 * A fader sent every input event — sixty a second on a touch screen, more with
 * a mouse — and drew whatever the server last echoed. The echoes arrive a
 * round trip late, so mid-drag the thumb jumped back to where it had been a
 * moment ago, and every step of the drag was a full state push to every page.
 *
 * Now the control shows its own value while it is being moved — the *draft*
 * — and sends at most one value per animation frame, always the latest. Let
 * go and the last value goes at once; the draft stays until the server
 * agrees with it, or a moment passes, so the thumb does not flick back to the
 * value from before the release either.
 */

// How long a released draft waits for the server to agree before the server's
// value is shown again, ms.
export const SETTLE_MS = 600;

const nextFrame = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

/** The latest of the values pushed, sent once a frame at most. */
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
    /** Send what is waiting now, if anything. */
    flush() {
      if (has) fire();
    },
    /** Drop what is waiting. */
    cancel() {
      has = false;
      pending = undefined;
    },
  };
}

/**
 * The state of one control's draft. `value(server)` is what to show;
 * `input` while it moves, `commit` when it is let go, `observe` with every
 * value the server reports.
 */
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
      // The release value always goes, even if the frame already sent it:
      // the server may have refused an earlier one.
      send(value);
      lastSent = value;
      draft = value;
      active = false;
      settleUntil = now() + settleMs;
      onChange();
    },
    /** The server reported a value: once it agrees with a released draft, the draft goes. */
    observe(server) {
      if (active || draft === undefined) return;
      if (server === lastSent || now() > settleUntil) clear();
    },
    get active() { return active; },
    /** Let go, and not yet confirmed. */
    get settling() { return !active && draft !== undefined; },
  };
}

/**
 * A draft for a control in a component: `[value, input, commit]`.
 *
 *   const [dim, onInput, onCommit] = useDraft(field('masterDimmer').value, (v) => send({ masterDimmer: v }));
 *   <input type="range" value={dim} onInput={(e) => onInput(+e.target.value)} onChange={(e) => onCommit(+e.target.value)} />
 *
 * `send` may change between renders; the latest one is used.
 */
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
