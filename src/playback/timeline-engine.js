'use strict';

/** Real-time renderer: consumes a prepared timeline and playback clock only. */
class TimelineEngine {
  constructor({ output, rate = 40, fallback = null } = {}) {
    this.output = output || (() => {}); this.rate = rate; this.fallback = fallback;
    this.timeline = []; this.clock = null; this.cursor = -1; this.timer = null; this.running = false; this._lastPosition = 0;
  }
  load(timeline = [], clock) { this.stop(); this.timeline = [...timeline].sort((a,b) => a.timeMs-b.timeMs); this.clock = clock; this.cursor = -1; this._lastPosition = 0; }
  start() { if (this.running || !this.clock) return; this.running = true; this._tick(); this.timer = setInterval(() => this._tick(), 1000 / this.rate); }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = null; }
  _tick() {
    if (!this.running) return;
    const position = typeof this.clock === 'function' ? this.clock() : this.clock.positionMs();
    // A seek or track change invalidates the event cursor. Do not replay a
    // whole timeline after a backwards jump; align to the new position.
    if (position + 50 < this._lastPosition) {
      this.cursor = this.timeline.findIndex(ev => ev.timeMs > position) - 1;
    }
    this._lastPosition = position;
    while (this.cursor + 1 < this.timeline.length && this.timeline[this.cursor + 1].timeMs <= position) this.output(this.timeline[++this.cursor]);
    if (this.cursor < 0 && this.fallback) this.output(this.fallback(position));
  }
}
module.exports = TimelineEngine;
