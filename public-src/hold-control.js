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
