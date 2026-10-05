// Voices (src/server/voices.ts): effects launched over the base look, held,
// once or latched, on a clock and a tempo the test drives. The energy
// effects' latch and hold over them (energy-hold.ts), and a disarm that
// stops every voice (apply.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { VoiceManager, HOLD_TIMEOUT_MS, lengthBeatsOf, launchOf, targetsOf, builtinPresets } from '../../src/server/voices.ts';
import { EnergyHold } from '../../src/server/energy-hold.ts';
import { createApplier } from '../../src/server/apply.ts';
import { settings } from '../../src/server/settings.ts';
import * as output from '../../src/server/output.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { scopedLoopLength } from '../../src/shared/effects/hd.ts';

const FADE = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };
const BLINDER = { kind: 'energy.blinder' };
// Faster than the photosensitivity threshold, though it says otherwise itself.
const FAST = { kind: 'ldj.StrobeCycle', params: { cadence: 0.25 }, rapidFlash: false };

/**
 * A manager on a clock of the test's own: `now` in ms, the beat moving at
 * `bpm` with it, and setTimeout mocked to match. `advance` moves both.
 */
function rig(t, { now = 1000, beat = 0, bpm = 120, running = false, acknowledged = true, onChange = () => {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = { now, beat, bpm, running, acknowledged, changes: 0 };
  const m = new VoiceManager({
    now: () => c.now, beatPos: () => c.beat, bpm: () => c.bpm,
    acknowledged: () => c.acknowledged, anyRunning: () => c.running, onChange: () => { c.changes++; onChange(); },
  });
  const advance = (ms) => {
    c.now += ms;
    c.beat += (ms / 60000) * c.bpm;
    t.mock.timers.tick(ms);
  };
  const ids = (at = c.now) => m.frames(at).map((v) => v.id);
  return { m, c, advance, ids };
}

const hold = (extra = {}) => ({ spec: FADE, targets: 'shared', mode: 'hold', tier: 'voice', source: 'pad', owner: 'tablet', token: 't1', ...extra });
const once = (extra = {}) => ({ spec: FADE, targets: 'shared', mode: 'once', tier: 'voice', source: 'api', ...extra });
const latched = (extra = {}) => ({ spec: FADE, targets: 'shared', mode: 'latched', tier: 'voice', source: 'api', ...extra });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} ≠ ${b}`);

// ── Holds ───────────────────────────────────────────────────────────────────

test('a hold without renewal dies after 1.2 s and onChange fires', (t) => {
  const { m, c, advance, ids } = rig(t);
  const v = m.start(hold());
  assert.equal(c.changes, 1);
  assert.deepEqual(ids(), [v.id]);
  advance(HOLD_TIMEOUT_MS - 1);
  assert.deepEqual(ids(), [v.id], 'alive a millisecond before its lease ends');
  assert.equal(c.changes, 1);
  advance(1);
  assert.equal(c.changes, 2, 'its own timer ended it and said so, with no frame asked for');
  assert.deepEqual(m.list(), []);
  assert.deepEqual(ids(), [], 'the base shows again');
  advance(10_000);
  assert.equal(c.changes, 2, 'once');
});

test('a dropped hold is gone from the frame at its lease even before its timer fires, and is ended once', (t) => {
  const { m, c, ids } = rig(t);
  const v = m.start(hold());
  // The frame a renderer works on without news ends where the lease does.
  assert.equal(m.frames(c.now)[0].untilMs, c.now + HOLD_TIMEOUT_MS);
  c.now += HOLD_TIMEOUT_MS;   // the clock moves, the timer has not fired yet
  assert.deepEqual(ids(), []);
  assert.equal(c.changes, 2, 'the frame check ended it');
  assert.equal(m.get(v.id), null);
  t.mock.timers.tick(HOLD_TIMEOUT_MS);
  assert.equal(c.changes, 2, 'and its timer found nothing left to end');
});

test('renew keeps it; release ends it; disconnect(owner) ends every voice of that owner', (t) => {
  const { m, c, advance, ids } = rig(t);
  const v = m.start(hold());
  for (let i = 0; i < 6; i++) {
    advance(1000);
    m.renew('tablet', 't1');
  }
  assert.deepEqual(ids(), [v.id], 'six seconds on renewals');
  m.renew('tablet', 'other');
  m.renew('phone', 't1');
  m.release('phone', 't1');
  m.release('tablet', 'other');
  assert.deepEqual(ids(), [v.id], 'another token or owner neither renews nor releases it');
  const before = c.changes;
  m.release('tablet', 't1');
  assert.deepEqual(ids(), []);
  assert.equal(c.changes, before + 1);
  m.release('tablet', 't1');
  assert.equal(c.changes, before + 1, 'a second release finds nothing');

  m.start(hold({ token: 'a' }));
  m.start(hold({ token: 'b', spec: BLINDER }));
  m.start(latched({ owner: 'tablet' }));
  const theirs = m.start(hold({ owner: 'phone', token: 'a' }));
  assert.equal(m.size, 4);
  m.disconnect('tablet');
  assert.deepEqual(m.list().map((s) => s.id), [theirs.id], 'everything the tablet launched went with it');
});

test('a renewal changes only the lease: same launch, same start, no change told; a lease already run out is not renewed', (t) => {
  const { m, c, advance } = rig(t);
  const v = m.start(hold());
  advance(500);
  m.renew('tablet', 't1');
  const [frame] = m.frames(c.now);
  assert.deepEqual([frame.launchSeq, frame.startedAtMs, frame.seed], [v.launchSeq, v.startedAtMs, v.seed]);
  assert.equal(frame.untilMs, c.now + HOLD_TIMEOUT_MS);
  assert.equal(c.changes, 1);
  // The old lease's timer fires at 1200 from the press; it was armed for an older lease.
  advance(HOLD_TIMEOUT_MS - 500);
  assert.ok(m.get(v.id), 'the renewed lease holds');
  c.now += HOLD_TIMEOUT_MS;   // past the lease, its timer not yet fired
  m.renew('tablet', 't1');
  assert.equal(m.get(v.id), null, 'a renewal after the lease ran out ends it instead');
});

test('the same owner and token: the same press renews; another effect replaces; a stale timer never removes the replacement', (t) => {
  const { m, c, advance } = rig(t);
  const first = m.start(hold());
  advance(600);
  const again = m.start(hold());
  assert.deepEqual([again.id, again.launchSeq], [first.id, first.launchSeq], 'not launched again');
  assert.equal(c.changes, 1);
  const other = m.start(hold({ spec: BLINDER }));
  assert.notEqual(other.id, first.id);
  assert.equal(m.get(first.id), null, 'one hold per owner and token');
  assert.equal(c.changes, 2, 'one change for the swap');
  // The first launch's lease would have run out here.
  advance(700);
  assert.ok(m.get(other.id), 'the replacement outlives the first lease');
  advance(HOLD_TIMEOUT_MS);
  assert.equal(m.get(other.id), null);

  // Pressed again after its lease ran out, before its timer fired: a new launch, not a revival.
  const late = m.start(hold());
  c.now += HOLD_TIMEOUT_MS;
  const fresh = m.start(hold());
  assert.notEqual(fresh.launchSeq, late.launchSeq);
  assert.equal(fresh.startedAtMs, c.now);
});

test('a quantised hold let go before its grid line never plays', (t) => {
  const { m, c, advance, ids } = rig(t, { beat: 10.1, running: true });
  const v = m.start(hold({ quantise: 8 }));
  near(v.startedAtMs, 3950, 'start on beat 16');
  // Its lease runs from the press: the frame a renderer is handed ends there, ahead of its start.
  assert.equal(m.frames(c.now, 5000)[0].untilMs, c.now + HOLD_TIMEOUT_MS);
  advance(1100);
  assert.equal(m.size, 1, 'waiting');
  advance(100);
  assert.equal(m.size, 0, 'its lease ran from the press, not from its start: gone at 2200');
  assert.deepEqual(ids(4000), []);
  m.start(hold({ quantise: 8, token: 't2' }));
  m.release('tablet', 't2');
  assert.deepEqual(ids(c.now + 10_000), [], 'released while waiting');
});

// ── Once and latched ────────────────────────────────────────────────────────

test('once with beats ends at startedAtMs + beats × 60000/bpm; with ms at startedAtMs + ms', (t) => {
  const { m, c, advance, ids } = rig(t, { bpm: 128 });
  const beats = m.start(once({ lengthBeats: 3 }));
  const ms = m.start(once({ lengthMs: 250, spec: BLINDER }));
  near(beats.untilMs, beats.startedAtMs + 3 * 60000 / 128, 'beats');
  assert.equal(ms.untilMs, ms.startedAtMs + 250);
  assert.equal(beats.startedAtMs, 1000, 'nothing ran: both now');
  advance(249);
  assert.deepEqual(ids(), [beats.id, ms.id]);
  advance(1);
  assert.deepEqual(ids(), [beats.id], 'half-open: gone at its end');
  const before = c.changes;
  advance(3 * 60000 / 128 - 250);
  assert.deepEqual(m.list(), [], 'ended by itself');
  assert.equal(c.changes, before + 1);
});

test('a once with no length plays its preset\'s, else its kind\'s: Hue Dynamics\' scoped loop, Light DJ\'s beats, a macro\'s loop, a beat or a bar', () => {
  const spec = (raw) => validateSpec(raw);
  assert.equal(lengthBeatsOf(spec({ kind: 'hd.simpleAdsr', scope: 'singleBeat' }), 16), 16, 'the preset\'s own length first');
  assert.equal(lengthBeatsOf(spec({ kind: 'hd.simpleAdsr', scope: 'singleBeat' })), 1);
  assert.equal(lengthBeatsOf(spec({ kind: 'hd.positionChase', params: { loopLength: 8 } })), 8);
  const measure = spec({ kind: 'hd.positionChase', scope: 'measure' });
  assert.equal(lengthBeatsOf(measure), scopedLoopLength(measure, measure.params));
  assert.equal(lengthBeatsOf(spec({ kind: 'ldj.Swirl' })), 32, 'a Light DJ kind\'s beats');
  assert.equal(lengthBeatsOf(spec({ kind: 'ldj.Swirl', params: { beats: 6 } })), 6);
  assert.equal(lengthBeatsOf(spec(FADE)), 32, 'Light DJ\'s iteration kinds count 32 beats');
  assert.equal(lengthBeatsOf(spec({ kind: 'macro', params: { steps: [{ effect: BLINDER, beats: 6 }], loopBeats: 6 } })), 6);
  assert.equal(lengthBeatsOf(spec({ kind: 'energy.glow' })), 4, 'no length of its own: a bar');
  assert.equal(lengthBeatsOf(spec({ kind: 'energy.glow', scope: 'singleBeat' })), 1);
  // A built-in looked up by its alias keeps its catalogue length.
  assert.equal(launchOf({ preset: 'ldj.FadeCycle' }, builtinPresets).lengthBeats, 32);
});

test('latched stays until stop, or until maxLatchMs', (t) => {
  const { m, c, advance, ids } = rig(t);
  const free = m.start(latched());
  const capped = m.start(latched({ maxLatchMs: 60_000, spec: BLINDER }));
  assert.equal(free.untilMs, null);
  assert.equal(capped.untilMs, capped.startedAtMs + 60_000);
  advance(59_999);
  assert.deepEqual(ids(), [free.id, capped.id]);
  advance(1);
  assert.deepEqual(ids(), [free.id], 'cut at its maximum');
  advance(24 * 3600_000);
  assert.deepEqual(ids(), [free.id], 'a latch with none stays');
  const before = c.changes;
  assert.equal(m.stop(free.id), true);
  assert.equal(m.stop(free.id), false);
  assert.equal(c.changes, before + 1);
  assert.deepEqual(ids(), []);
});

test('a wait longer than a Node timer takes is chained, not cut short', (t) => {
  const { m, advance } = rig(t);
  const days = 40 * 24 * 3600_000;    // past 2^31 ms
  const step = 2 ** 31 - 1;
  const v = m.start(latched({ maxLatchMs: days }));
  advance(step);
  assert.ok(m.get(v.id), 'still latched after the first step');
  advance(days - step - 1);
  assert.ok(m.get(v.id));
  advance(1);
  assert.equal(m.get(v.id), null);
});

test('no voice keeps the process alive: an hour\'s latch, an hour\'s once and a hold, all pending, and it still exits', () => {
  const url = new URL('../../src/server/voices.ts', import.meta.url).href;
  const script = `const { VoiceManager } = await import('${url}');
    const m = new VoiceManager({ now: () => performance.now(), onChange() {}, acknowledged: () => true });
    const base = { spec: { kind: 'energy.glow' }, targets: 'shared', tier: 'voice', source: 'api' };
    m.start({ ...base, mode: 'latched', maxLatchMs: 3600000 });
    m.start({ ...base, mode: 'once', lengthMs: 3600000 });
    m.start({ ...base, mode: 'hold', owner: 'page', token: 't' });
    console.log(m.size);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  assert.deepEqual([run.status, run.stdout.trim()], [0, '3'], run.stderr);
});

// ── Launch timing ───────────────────────────────────────────────────────────

test('nothing running → a quantised launch starts now; something running → it snaps up to the next grid line and frames() omits it before then', (t) => {
  const { m, c, ids } = rig(t, { beat: 10.1, bpm: 120 });
  const primed = m.start(once({ quantise: 0.25, lengthBeats: 4 }));
  assert.equal(primed.startedAtMs, 1000, 'primed: at once');
  assert.equal(primed.anchorBeat, 10.1);
  m.stopAll();

  c.running = true;
  const snapped = m.start(once({ quantise: 0.25, lengthBeats: 4 }));
  near(snapped.startedAtMs, 1075, 'beat 10.25 at 120 BPM');
  near(snapped.untilMs, 3075, 'four beats on');
  assert.equal(snapped.anchorBeat, 10.25);
  assert.deepEqual(ids(1074), []);
  assert.deepEqual(ids(1076), [snapped.id]);
  assert.equal(m.list()[0].startedAt - m.list()[0].until, -2000, 'listed with its start ahead');

  // A voice playing counts as something running.
  c.running = false;
  const after = m.start(once({ quantise: 1, lengthMs: 100, spec: BLINDER }));
  near(after.startedAtMs, 1000 + 0.9 * 500, 'the next whole beat');

  // Exactly on a grid line: then.
  c.running = true;
  c.beat = 10.25;
  const onLine = m.start(once({ quantise: 0.25, lengthMs: 100, spec: { kind: 'energy.glow' } }));
  assert.equal(onLine.startedAtMs, 1000);
  // Quantise 0 is now.
  c.beat = 10.3;
  assert.equal(m.start(once({ quantise: 0, lengthMs: 100, spec: { kind: 'energy.kill' } })).startedAtMs, 1000);
});

test('a voice past its end, its timer not fired yet, leaves nothing running: the next quantised launch starts now', (t) => {
  const { m, c } = rig(t, { beat: 10.1, bpm: 120 });
  m.start(once({ lengthMs: 100 }));
  m.start(hold({ token: 'gone' }));
  c.now += HOLD_TIMEOUT_MS;   // both are over, neither timer has run
  c.beat += 2.4;
  const v = m.start(once({ quantise: 1, lengthMs: 100, spec: BLINDER }));
  assert.equal(v.startedAtMs, c.now, 'primed');
  near(v.anchorBeat, 12.5, 'from the beat it was pressed on');
  // Something still playing keeps the grid.
  const w = m.start(once({ quantise: 1, lengthMs: 100, spec: { kind: 'energy.glow' } }));
  near(w.startedAtMs, c.now + 0.5 * 500, 'the next whole beat');
});

test('frames() carries tier, launchSeq, ms times and resolves targets to fixture ids; a conductor epoch bump leaves a running voice running', (t) => {
  const { m, c, ids } = rig(t, { beat: 3 });
  const a = m.start(once({ lengthBeats: 8, targets: [2, 0, 2] }));
  const b = m.start(latched({ spec: BLINDER, tier: 'strobe', targets: 'shared' }));
  const empty = m.start(latched({ spec: { kind: 'energy.glow' }, targets: [] }));
  const frames = m.frames(c.now);
  assert.deepEqual(frames.map((f) => [f.id, f.tier, f.launchSeq, f.targets, f.startedAtMs, f.untilMs, f.anchorBeat]), [
    [a.id, 'voice', 1, [2, 0], 1000, 5000, 3],
    [b.id, 'strobe', 2, null, 1000, null, 3],
    [empty.id, 'voice', 3, [], 1000, null, 3],
  ]);
  assert.equal(frames[0].spec.kind, 'ldj.FadeCycle');
  assert.equal(frames[0].seed.length, 4);
  assert.ok(frames.every((f) => !('holdsGrid' in f)), 'a voice re-anchors when the music jumps unless it says otherwise');
  assert.deepEqual(m.list()[0].targets, [2, 0], 'the wire form: ids');
  assert.equal(m.list()[1].targets, 'shared');

  // The music jumps (a new epoch, a new tempo): the stored times stay.
  c.beat = 200;
  c.bpm = 128;
  assert.deepEqual(m.frames(c.now).map((f) => [f.startedAtMs, f.untilMs, f.anchorBeat]), frames.map((f) => [f.startedAtMs, f.untilMs, f.anchorBeat]));
  assert.deepEqual(ids(4999), [a.id, b.id, empty.id]);
  assert.equal(m.get(a.id).untilMs, 5000);
});

test('a key replaces', (t) => {
  const { m, c, ids } = rig(t);
  const first = m.start(latched({ key: 'board' }));
  const second = m.start(latched({ key: 'board', spec: BLINDER }));
  assert.notEqual(first.id, second.id);
  assert.ok(second.launchSeq > first.launchSeq);
  assert.deepEqual(ids(), [second.id]);
  assert.equal(c.changes, 2);
  // An id given is a key too.
  const named = m.start(latched({ id: 'strobe' }));
  const again = m.start(latched({ id: 'strobe', spec: BLINDER }));
  assert.deepEqual([named.id, again.id], ['strobe', 'strobe']);
  assert.ok(again.launchSeq > named.launchSeq);
  assert.deepEqual(ids(), [second.id, 'strobe']);
});

test('a rapidFlash spec is refused until acknowledged', (t) => {
  const { m, c } = rig(t, { acknowledged: false });
  const playing = m.start(latched({ key: 'k' }));
  for (const spec of [FAST, { kind: 'energy.whiteStrobe' }, { kind: 'strobe' }, { ...FADE, rapidFlash: true }]) {
    assert.throws(() => m.start(latched({ spec, key: 'k' })), (err) => err.status === 409 && /photosensitivity acknowledgement required/.test(err.message), spec.kind);
  }
  assert.deepEqual(m.list().map((s) => s.id), [playing.id], 'what played plays on');
  assert.equal(c.changes, 1);
  // The energy endpoints' way: admitted, and the renderer holds it dark.
  assert.ok(m.start(latched({ spec: { kind: 'energy.whiteStrobe' }, admission: 'render' })));
  // Stopping needs nothing.
  assert.equal(m.stopAll(), 2);
  c.acknowledged = true;
  assert.ok(m.start(latched({ spec: FAST })));
});

test('a launch is checked whole before it replaces anything; what it was given is copied', (t) => {
  const { m } = rig(t);
  const playing = m.start(latched({ key: 'k' }));
  const refused = [
    latched({ key: 'k', spec: { kind: 'no.such' } }),
    latched({ key: 'k', targets: [1.5] }),
    latched({ key: 'k', targets: 'all' }),
    once({ key: 'k', quantise: -1 }), once({ key: 'k', quantise: NaN }),
    once({ key: 'k', lengthMs: 0 }), once({ key: 'k', lengthBeats: Infinity }), once({ key: 'k', lengthMs: 1, lengthBeats: 1 }),
    latched({ key: 'k', lengthMs: 100 }), hold({ key: 'k', maxLatchMs: 100 }),
    hold({ key: 'k', owner: undefined }), hold({ key: 'k', token: undefined }),
    once({ key: 'k', lengthMs: Number.MAX_VALUE * 2 }), once({ key: 'k', lengthBeats: Number.MAX_VALUE }),
  ];
  for (const v of refused) assert.throws(() => m.start(v), (err) => err.status === 400, JSON.stringify(v));
  assert.deepEqual(m.list().map((s) => s.id), [playing.id]);

  const spec = { kind: 'ldj.FadeCycle', params: { cadence: 2 } };
  const targets = [0, 1];
  const v = m.start(latched({ spec, targets }));
  spec.params.cadence = 8;
  targets.push(9);
  const frame = m.frames(1000).find((f) => f.id === v.id);
  assert.deepEqual([frame.spec.params.cadence, frame.targets], [2, [0, 1]]);
  assert.throws(() => { frame.spec.params.cadence = 4; }, TypeError, 'the spec a voice plays is frozen');
});

test('a hidden voice keeps its launch and timers and renders nothing', (t) => {
  const { m, c, advance, ids } = rig(t);
  const v = m.start(once({ lengthMs: 500 }));
  m.setHidden(v.id, true);
  assert.deepEqual(ids(), []);
  assert.equal(m.list()[0].hidden, true);
  m.setHidden(v.id, false);
  assert.deepEqual(ids(), [v.id]);
  m.setHidden(v.id, true);
  advance(500);
  assert.equal(m.size, 0, 'its end came while hidden');
  assert.equal(c.changes, 2);
});

// ── Requests ────────────────────────────────────────────────────────────────

test('a request names an effect or a preset, never both; targets are "shared" or fixture ids of the patch', () => {
  assert.throws(() => launchOf({}, builtinPresets), /either effect or preset/);
  assert.throws(() => launchOf({ effect: FADE, preset: 'blinder' }, builtinPresets), /either effect or preset/);
  assert.throws(() => launchOf({ preset: 'no-such' }, builtinPresets), (err) => err.status === 400 && /No such preset/.test(err.message));
  assert.throws(() => launchOf({ preset: 'chase' }, builtinPresets), (err) => err.status === 400, 'a legacy pattern is no effect');
  assert.throws(() => launchOf({ effect: { kind: 'ldj.FadeCycle', params: { cadence: 'fast' } } }, builtinPresets),
    (err) => err.status === 400 && /^effect\.params/.test(err.message));
  const blinder = launchOf({ preset: 'blinder' }, builtinPresets);
  assert.deepEqual([blinder.spec.kind, blinder.label], ['energy.blinder', 'Blinder']);
  assert.equal(targetsOf(undefined, [0, 1]), 'shared');
  assert.equal(targetsOf('shared', [0, 1]), 'shared');
  assert.deepEqual(targetsOf([1, 1, 0], [0, 1]), [1, 0]);
  assert.deepEqual(targetsOf([], [0, 1]), [], 'an empty list stays empty');
  assert.throws(() => targetsOf([7], [0, 1]), /no fixture 7/);
  assert.throws(() => targetsOf('all', [0, 1]), (err) => err.status === 400);
});

// ── The energy effects' latch and hold ─────────────────────────────────────

/** The shim over a manager of the test's own, with what it shows. */
function energy(t) {
  let shim = null;
  // Partway through a bar, so the global grid's beat 0 is not the launch's.
  const r = rig(t, { beat: 5.3, onChange: () => shim.sync() });
  const told = [];
  shim = new EnergyHold((effect) => told.push(effect), r.m);
  const visible = () => r.m.frames(r.c.now).map((f) => f.id);
  return { ...r, shim, told, visible };
}

test('the energy effects as voices: a hold plays over the latch, the latch comes back as it was', (t) => {
  const { m, shim, told, visible, advance } = energy(t);
  shim.latch('blinder');
  const latch = m.get('energy:blinder');
  assert.deepEqual([latch.mode, latch.tier, latch.source, latch.anchorBeat, latch.targets], ['latched', 'voice', 'energy', 0, null]);
  assert.deepEqual(visible(), ['energy:blinder']);
  // On the global beat grid, and the renderer told to keep it there when the music jumps.
  assert.equal(m.frames(1000)[0].holdsGrid, true);
  shim.latch('blinder');
  assert.equal(m.get('energy:blinder').launchSeq, latch.launchSeq, 'the same effect again is no new launch');

  // The same effect held over itself, then let go: the latch is the one launched first.
  shim.press('page', 'p1', 'blinder');
  assert.deepEqual(visible(), ['energy:blinder:hold']);
  assert.deepEqual([shim.held(), shim.latched()], ['blinder', 'blinder']);
  advance(400);
  shim.release('page', 'p1');
  assert.deepEqual(visible(), ['energy:blinder']);
  assert.deepEqual(m.get('energy:blinder'), latch, 'its launch, start and seed untouched');

  // The latch changed while held waits, hidden, and plays when the hold goes.
  shim.press('page', 'p2', 'kill');
  shim.latch('glow');
  assert.deepEqual(visible(), ['energy:kill:hold']);
  assert.equal(shim.latched(), 'glow');
  const glow = m.get('energy:glow');
  assert.ok(glow.hidden && glow.launchSeq > m.get('energy:kill:hold').launchSeq, 'the later launch, hidden: the hold keeps the top');
  shim.latch(null);
  shim.release('page', 'p2');
  assert.deepEqual(visible(), [], 'cleared while held: nothing comes back');
  assert.deepEqual(told, ['blinder', null, 'kill', null]);

  // The hold strobe is the strobe tier; an id that is no energy effect clears the latch.
  shim.latch('palette-strobe');
  assert.equal(m.get('energy:palette-strobe').tier, 'strobe');
  shim.latch('no-such');
  assert.equal(shim.latched(), null);
});

test('a latch that ended while hidden never comes back; off takes only the latch', (t) => {
  const { m, shim, visible } = energy(t);
  shim.latch('glow');
  shim.press('page', 'p1', 'blinder');
  m.stop('energy:glow');    // DELETE /api/voices/energy:glow, say
  shim.release('page', 'p1');
  assert.deepEqual(visible(), []);
  assert.equal(shim.latched(), null);

  shim.latch('glow');
  shim.press('page', 'p2', 'kill');
  shim.latch(null);         // /api/energy/off
  assert.equal(shim.held(), 'kill', 'the hold plays on');
  assert.deepEqual(visible(), ['energy:kill:hold']);

  // A stop of everything leaves nothing a release could bring back.
  shim.latch('uv-wash');
  m.stopAll();
  shim.release('page', 'p2');
  shim.press('page', 'p3', 'glow');
  shim.release('page', 'p3');
  assert.deepEqual(visible(), []);
  assert.equal(m.size, 0);
});

test('a strobe energy is taken unacknowledged, as the endpoints always answered: the renderer holds it dark', (t) => {
  const { m, c, shim } = energy(t);
  c.acknowledged = false;
  shim.latch('white-strobe');
  shim.press('page', 'p1', 'palette-strobe');
  assert.deepEqual([shim.latched(), shim.held()], ['white-strobe', 'palette-strobe']);
  assert.equal(m.size, 2);
});

// ── Disarm ──────────────────────────────────────────────────────────────────

test('disarm (apply.ts) stops every voice', (t) => {
  const { m, c } = rig(t, { beat: 0.5 });
  const saved = settings.all();
  settings.save = () => {};
  settings.useDefaults();
  t.after(() => {
    output.setArmed(false);
    settings._values = saved;
    delete settings.save;
  });
  const applied = [];
  const applier = createApplier({
    midi: { close() {}, connect() { return true; }, setControlFeedback() {} },
    spotify: { localCallbackUrl: '', setLoopbackPort() {}, configure() {} },
    smtc: { start() {}, stop() {} },
    deezer: { init: async () => {} },
    applyPatch: (patch) => applied.push(patch),
    broadcast() {},
    voices: m,
  });
  applier.applyChanged(settings.update({ outputs: { armed: true } }));
  m.start(hold());
  assert.ok(m.start(once({ quantise: 4, lengthMs: 100 })).startedAtMs > c.now, 'waiting for beat 4');
  m.start(latched({ spec: BLINDER }));
  m.setHidden(m.start(latched({ spec: { kind: 'energy.glow' } })).id, true);
  applier.applyChanged(settings.update({ outputs: { armed: false } }));
  assert.equal(m.size, 0, 'held, waiting, latched and hidden alike');
  assert.deepEqual(applied, [{ running: false, energyOverride: null }]);

  // A rehearsal plays voices while disarmed; a disarm asked for again stops them.
  m.start(latched());
  applier.applyChanged(settings.update({ outputs: { armed: false } }));
  assert.equal(m.size, 1, 'a save that changed nothing does nothing');
  assert.equal(applier.disarmed(), 1);
  assert.equal(m.size, 0);
});
