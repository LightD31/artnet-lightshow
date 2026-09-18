'use strict';

// A browser must keep a momentary effect alive. Losing the release packet,
// closing the tab, or a broken connection can therefore never latch the effect.
const HOLD_TIMEOUT_MS = 1200;

class EnergyHold {
  constructor(onChange) {
    this.onChange = onChange;
    this.active = null;
    this.timer = null;
  }

  press(owner, token, effect) {
    if (this.active) this.release(this.active.owner, this.active.token);
    this.active = { owner, token, effect };
    this._renew();
    this.onChange(effect);
  }

  renew(owner, token) {
    if (this._owns(owner, token)) this._renew();
  }

  release(owner, token) {
    if (!this._owns(owner, token)) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
    this.onChange(null);
  }

  disconnect(owner) {
    if (this.active?.owner === owner) this.release(owner, this.active.token);
  }

  _owns(owner, token) {
    return !!this.active && this.active.owner === owner && this.active.token === token;
  }

  _renew() {
    clearTimeout(this.timer);
    const { owner, token } = this.active;
    this.timer = setTimeout(() => this.release(owner, token), HOLD_TIMEOUT_MS);
    this.timer.unref?.();
  }
}

module.exports = { EnergyHold, HOLD_TIMEOUT_MS };
