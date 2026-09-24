// The operator's edits to one track's show (src/show/overlay.ts), kept with
// its analysis and put back on every plan of it.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ShowDirector } from '../../src/show/director.ts';
import { INTENT, BURST } from '../../src/show/intents.ts';
import { applyOverlay } from '../../src/show/overlay.ts';
import { COLOR_PRESETS, PATTERNS } from '../../src/server/presets.ts';
import { overlaySchema } from '../../src/server/validation.ts';
import { AnalysisCache } from '../../src/analysis-cache.ts';
import AutoShow from '../../src/auto-show.ts';

const TRACKS = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
const FILE = 'p-nk-try.json';
const load = () => { const d = JSON.parse(fs.readFileSync(path.join(TRACKS, FILE), 'utf8')); return d.analysis || d; };
const plan = (overlay = null, extra = {}) => new ShowDirector({
  patterns: PATTERNS, colorPresets: COLOR_PRESETS, paletteSize: 4, intensity: 60, overlay, ...extra,
}).plan(load());

test('a locked palette holds whatever the night would choose', () => {
  const free = plan();
  const other = free.paletteName === 'arctic' ? 'volcanic' : 'arctic';
  assert.strictEqual(plan({ palette: other }).paletteName, other);
  // Even straight after a track in that very palette.
  const previous = { key: 'b', at: 0, ...free.memory, paletteName: other };
  const locked = plan({ palette: other }, { history: { previous, recent: [previous], setMinutes: 60 } });
  assert.strictEqual(locked.paletteName, other);
});

test('a section the operator gave a look holds it, rotation and all', () => {
  const free = plan();
  const section = free.context.sections.find((s) => !s.resting && s.end - s.start > 30);
  const edited = plan({ sections: [{ atMs: Math.round(section.start * 1000) + 500, pattern: 'sparkle' }] });
  const inside = edited.intents.filter((i) => i.kind === INTENT.SCENE && i.timeMs >= section.start * 1000 - 2000 && i.timeMs < section.end * 1000);
  const opening = inside.find((i) => String(i.source).startsWith('section:'));
  assert.strictEqual(opening.pattern, 'sparkle');
  assert.ok(!inside.some((i) => i.source === 'rotation'), 'no rotation inside a section the operator set');
  const before = free.intents.filter((i) => i.kind === INTENT.SCENE && i.timeMs < section.start * 1000 - 2000);
  const after = edited.intents.filter((i) => i.kind === INTENT.SCENE && i.timeMs < section.start * 1000 - 2000);
  assert.deepStrictEqual(after, before, 'the rest of the track is untouched');
});

test('an accent added fires whatever the budget says, and one taken away is gone', () => {
  const free = plan();
  const accents = (p) => p.intents.filter((i) => i.kind === INTENT.ACCENT);
  const victim = accents(free)[0];
  const edited = plan({ accents: { add: [{ atMs: 61234, burst: BURST.BLINDER }], remove: [victim.timeMs + 40] } });
  assert.ok(accents(edited).some((a) => a.timeMs === 61234 && a.burst === BURST.BLINDER && a.source === 'operator'));
  assert.ok(!accents(edited).some((a) => a.timeMs === victim.timeMs), 'taken away, 40 ms off');
  assert.strictEqual(accents(edited).length, accents(free).length, 'one in, one out');
});

test('no overlay, no change', () => {
  const intents = plan().intents;
  assert.deepStrictEqual(applyOverlay(intents, {}, []), intents);
  assert.deepStrictEqual(plan({}).intents, intents);
});

test('the schema takes an overlay and refuses what is not one', () => {
  assert.ok(overlaySchema.safeParse({ palette: 'arctic', sections: [{ atMs: 1000, pattern: 'wave', pixelPattern: null }], accents: { add: [{ atMs: 5, burst: 'kill' }], remove: [7] } }).success);
  assert.ok(!overlaySchema.safeParse({ accents: { add: [{ atMs: 5, burst: 'fireworks' }] } }).success);
  assert.ok(!overlaySchema.safeParse({ palette: '../etc' }).success);
  assert.ok(!overlaySchema.safeParse({ sections: [{ atMs: -1 }] }).success);
});

test('edits are kept beside the analysis, survive it being analysed again, and replan the show', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'));
  try {
    const cache = new AnalysisCache(dir);
    cache.set('track', load());
    const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS, cache);
    show._worker.shutdown();
    show.analysis = load();
    show.analysisKey = 'track';
    show.buildTimeline();
    const other = show.paletteName === 'arctic' ? 'volcanic' : 'arctic';
    const revision = show.timelineRevision;
    show.setOverlay({ palette: other });
    assert.strictEqual(show.paletteName, other, 'replanned with it');
    assert.notStrictEqual(show.timelineRevision, revision);

    cache.set('track', load());                        // analysed again
    assert.deepStrictEqual(cache.overlay('track'), { palette: other });
    assert.strictEqual(cache.count(), 1, 'an overlay is not an entry');

    const later = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS, cache);
    later._worker.shutdown();
    later.analysis = load();
    later.analysisKey = 'track';
    later.buildTimeline();
    assert.strictEqual(later.paletteName, other, 'the next time the track plays');

    later.setOverlay({});
    assert.strictEqual(cache.overlay('track'), null, 'cleared edits leave nothing behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The routes ──────────────────────────────────────────────────────────────

import express from 'express';
import { attachRoutes } from '../../src/server/routes.ts';

test('GET and PUT /api/auto/overlay read and replace the loaded track\'s edits', async () => {
  const stored = [];
  const autoShow = {
    analysis: null, analysisKey: 'track', timelineRevision: 'r1', _overlay: null,
    overlay() { return this._overlay; },
    setOverlay(o) { this._overlay = o; stored.push(o); this.timelineRevision = 'r2'; },
    getClientState: () => ({}),
  };
  const app = express();
  app.use(express.json());
  attachRoutes(app, { autoShow, integrations: { broadcast() {} } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auto/overlay`, {
      method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.strictEqual((await call('GET')).status, 404, 'no track, no edits');
    autoShow.analysis = {};
    assert.deepStrictEqual((await call('GET')).body.overlay, {});
    const edit = { palette: 'arctic', accents: { add: [{ atMs: 1000, burst: 'kill' }] } };
    const put = await call('PUT', edit);
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual(put.body.overlay, edit);
    assert.strictEqual(put.body.revision, 'r2', 'replanned');
    const bad = await call('PUT', { accents: { add: [{ atMs: 1000, burst: 'fireworks' }] } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(stored.length, 1, 'a refused edit changes nothing');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
