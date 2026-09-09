'use strict';

const PRIORITY = { current: 0, next: 1, normal: 2, background: 3 };

/** Queue-based pre-analysis coordinator. It never runs from the render tick. */
class AnalysisQueue {
  constructor({ cache, analyze, onChange = () => {} } = {}) {
    this.cache = cache; this.analyze = analyze; this.onChange = onChange;
    this.jobs = new Map(); this.running = false; this._sequence = 0;
  }
  enqueue(track, priority = 'normal') {
    if (!track || !track.key) return null;
    const existing = this.jobs.get(track.key);
    if (existing) { if (PRIORITY[priority] < PRIORITY[existing.priority]) existing.priority = priority; return existing; }
    const job = { key: track.key, track, priority, status: this.cache?.has(track.key) ? 'ready' : 'queued', order: this._sequence++ };
    this.jobs.set(job.key, job); this.onChange(job); this._drain(); return job;
  }
  enqueueMany(tracks, priority = 'background') { return (tracks || []).map(t => this.enqueue(t, priority)); }
  status() { return [...this.jobs.values()].sort((a,b) => a.order-b.order).map(({key, track, priority, status, error}) => ({key, track, priority, status, error: error || null})); }
  async _drain() {
    if (this.running) return;
    const next = [...this.jobs.values()].filter(j => j.status === 'queued').sort((a,b) => PRIORITY[a.priority]-PRIORITY[b.priority] || a.order-b.order)[0];
    if (!next) return;
    this.running = true; next.status = 'analysing'; this.onChange(next);
    try { await this.analyze(next.track); next.status = 'ready'; }
    catch (e) { next.status = 'failed'; next.error = e.message; }
    this.running = false; this.onChange(next); this._drain();
  }
}
module.exports = { AnalysisQueue, PRIORITY };
