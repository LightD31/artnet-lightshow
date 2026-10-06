// Track the local press independently of server echoes. A release may happen
// before the first state update arrives, especially from a phone over Wi-Fi.
export function createHoldControl(emit) {
  let held = null;
  let timer = null;
  let sequence = 0;

  const release = () => {
    if (!held) return;
    const token = held;
    held = null;
    clearInterval(timer);
    timer = null;
    emit({ action: 'release', token });
  };

  return {
    press(effect) {
      release();
      const token = String(++sequence);
      if (!emit({ action: 'press', token, effect })) return false;
      held = token;
      timer = setInterval(() => {
        if (!emit({ action: 'renew', token })) release();
      }, 300);
      return true;
    },
    release,
  };
}

/**
 * Several holds at once, one per key (a pad, the strobe), each with its own
 * token so the server can tell them apart. `target` ({ pad } or { effect })
 * rides every message of that hold, the release included. `onEnd`
 * listeners hear of every hold that ends, however it ended.
 */
export function createVoiceHolds(emit) {
  const holds = new Map();
  const ended = new Set();
  let sequence = 0;
  let newest = null;

  const release = (key) => {
    const hold = holds.get(key);
    if (!hold) return;
    holds.delete(key);
    hold.control.release();
    for (const listener of [...ended]) listener(key);
  };

  return {
    press(key, target) {
      release(key);
      const id = ++sequence;
      const control = createHoldControl((payload) => emit({ action: payload.action, token: `${id}:${payload.token}`, ...target }));
      if (!control.press()) return false;
      holds.set(key, { control });
      newest = key;
      return true;
    },
    release,
    releaseAll() { for (const key of [...holds.keys()]) release(key); },
    // The server's refusal carries no token; it answers the newest press.
    refuse() { if (newest !== null) release(newest); newest = null; },
    held() { return [...holds.keys()]; },
    onEnd(listener) { ended.add(listener); return () => ended.delete(listener); },
  };
}
