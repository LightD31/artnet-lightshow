// A browser must keep a momentary effect alive. Losing the release packet,
// closing the tab, or a broken connection can therefore never latch the effect.
const HOLD_TIMEOUT_MS = 1200;

class EnergyHold {
  declare onChange: (effect: string | null) => void;
  declare active: { owner: string; token: unknown; effect: string } | null;
  declare timer: ReturnType<typeof setTimeout> | null;

  constructor(onChange: (effect: string | null) => void) {
    this.onChange = onChange;
    this.active = null;
    this.timer = null;
  }

  press(owner: string, token: unknown, effect: string): void {
    if (this.active) this.release(this.active.owner, this.active.token);
    this.active = { owner, token, effect };
    this._renew();
    this.onChange(effect);
  }

  renew(owner: string, token: unknown): void {
    if (this._owns(owner, token)) this._renew();
  }

  release(owner: string, token: unknown): void {
    if (!this._owns(owner, token)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.onChange(null);
  }

  disconnect(owner: string): void {
    if (this.active?.owner === owner) this.release(owner, this.active.token);
  }

  _owns(owner: string, token: unknown): boolean {
    return !!this.active && this.active.owner === owner && this.active.token === token;
  }

  _renew(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active) return;
    const { owner, token } = this.active;
    const timer = setTimeout(() => this.release(owner, token), HOLD_TIMEOUT_MS);
    timer.unref?.();
    this.timer = timer;
  }
}

export {
  EnergyHold,
  HOLD_TIMEOUT_MS,
};
