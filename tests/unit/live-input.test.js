// The live input from the server's side: a Python process that hears the music
// writes a line every hop, and the server reads those lines onto its own clock
// — the beat for "now", not for the last hop — keeps the process alive, and
// lets the pattern clock follow what it hears when nothing else knows the track.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';

import LiveInput, { BAND_HZ_MAX, MAX_BANDS, listLiveDevices } from '../../src/live-input.ts';
import { Conductor } from '../../src/server/conductor.ts';
import { makeGrid } from '../../src/shared/beat-clock.ts';

const state = (over = {}) => JSON.stringify({
  type: 'state', t: 10, captured: 10.035, beat: 20.5, bpm: 120, phase: 0.5, locked: true,
  energy: 0.1, onset: 0.2, flux: 0.3, rms: 0.05, tension: 0.4, bands: { bass: 0.2 }, ...over,
});

function clocked() {
  let now = 50000;
  const live = new LiveInput({ now: () => now, spawner: () => { throw new Error('no process in this test'); } });
  live._stopped = false;
  live._options = { source: 'loopback' };
  return { live, advance: (ms) => { now += ms; }, get now() { return now; } };
}

test('the beat is read for now, from the least-delayed line', () => {
  const c = clocked();
  assert.strictEqual(c.live.getBeatReading(), null, 'nothing heard yet');

  // Captured 10.035 s of audio, arriving at 50 000 ms: stream time 0 is 39 965.
  c.live.handleLine(state());
  let r = c.live.getBeatReading();
  // Now is stream 10.035 s; the beat was 20.5 at 10.0 s; 35 ms at 120 BPM is 0.07 beats.
  assert.ok(Math.abs(r.beatPos - 20.57) < 1e-9, `beat ${r.beatPos}`);
  assert.strictEqual(r.bpm, 120);

  // The next line was held up 30 ms on the way: the earlier arrival still
  // decides where stream time sits.
  c.advance(11.6 + 30);
  c.live.handleLine(state({ t: 10.0116, captured: 10.0466, beat: 20.5232 }));
  r = c.live.getBeatReading();
  const streamNow = 10.035 + (11.6 + 30) / 1000;
  assert.ok(Math.abs(r.beatPos - (20.5232 + (streamNow - 10.0116) * 2)) < 1e-9);

  // The room hears it 40 ms after the sound card does.
  c.live._options.latencyMs = 40;
  assert.ok(Math.abs(c.live.getBeatReading().beatPos - (r.beatPos - 0.08)) < 1e-9);
});

test('no beat without a lock, and none once the lines stop', () => {
  const c = clocked();
  c.live.handleLine(state({ locked: false }));
  assert.strictEqual(c.live.getBeatReading(), null, 'heard, but no grid yet');
  // Locked, then a moment's doubt after a drop: the grid runs on, and so does
  // the beat — for a few seconds.
  c.live.handleLine(state());
  c.advance(2000);
  c.live.handleLine(state({ locked: false }));
  assert.ok(c.live.getBeatReading(), 'held through a lapse');
  c.advance(2100);
  c.live.handleLine(state({ locked: false }));
  assert.strictEqual(c.live.getBeatReading(), null, 'not for long');
  c.live.handleLine(state({ beat: null }));
  assert.strictEqual(c.live.getBeatReading(), null);
  c.live.handleLine(state());
  assert.ok(c.live.getBeatReading());
  c.advance(600);
  assert.strictEqual(c.live.getBeatReading(), null, 'half a second of silence from the process');
  assert.strictEqual(c.live.status().listening, false);
});

// A tempo taken by hand from the live beat holds until the tracker finds a
// new one (conductor.ts): the reading says which lock it belongs to.
test('a lock found after the last one lapsed is a new one', () => {
  const c = clocked();
  c.live.handleLine(state());
  const first = c.live.getBeatReading().key;
  c.advance(2000);
  c.live.handleLine(state({ locked: false }));
  c.advance(1000);
  c.live.handleLine(state());
  assert.strictEqual(c.live.getBeatReading().key, first, 'a moment\'s doubt is the same lock');
  c.advance(300);
  c.live.handleLine(state());
  assert.strictEqual(c.live.getBeatReading().key, first, 'and so are the lines after it');

  c.advance(4100);
  c.live.handleLine(state({ locked: false }));
  assert.strictEqual(c.live.getBeatReading(), null, 'lost');
  c.advance(100);
  c.live.handleLine(state());
  const second = c.live.getBeatReading().key;
  assert.notStrictEqual(second, first, 'found again: a new lock');

  // A process that dies takes its lock with it.
  c.live._forgetStream();
  c.live.handleLine(state());
  assert.notStrictEqual(c.live.getBeatReading().key, second);
});

test('events, status and the envelope for lining a track up', () => {
  const c = clocked();
  const events = [];
  const statuses = [];
  c.live.onEvent((e) => events.push(e.type));
  c.live.onStatus((s) => statuses.push(s));
  c.live.handleLine(JSON.stringify({ type: 'ready', backend: 'soundcard', device: 'Speakers', sampleRate: 22050, hop: 256 }));
  for (let i = 0; i < 40; i++) {
    c.live.handleLine(state({ t: i, captured: i + 0.035, flux: i, rms: i / 100 }));
    c.advance(1000);
  }
  c.live.handleLine(JSON.stringify({ type: 'event', event: { t: 5, type: 'DROP', confidence: 0.45, intensity: 0.8, duration: 0, effect: 'flash' } }));
  c.live.handleLine('not json');
  assert.deepStrictEqual(events, ['DROP']);
  assert.deepStrictEqual([statuses[0].backend, statuses[0].device, statuses[0].listening], ['soundcard', 'Speakers', false]);
  const env = c.live.recentEnvelope(10);
  assert.deepStrictEqual([env[0].t, env[env.length - 1].t, env.length], [29, 39, 11]);
  assert.strictEqual(c.live.recentEnvelope().length, 31, 'thirty seconds kept');

  c.live.handleLine(JSON.stringify({ type: 'error', fatal: true, message: 'no audio capture backend: pip install soundcard' }));
  assert.ok(c.live.status().error);
});

// ── The process ───────────────────────────────────────────────────────────────

/** A stand-in process; `asked` holds the lines written to its stdin. Without `stdin` it takes none. */
function fakeProcess({ stdin = true } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.asked = [];
  if (stdin) {
    proc.stdin = new PassThrough();
    proc.stdin.on('data', (d) => proc.asked.push(...d.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  }
  proc.killed = false;
  proc.kill = () => { proc.killed = true; proc.emit('close', null); };
  return proc;
}
const settle = () => new Promise((r) => setImmediate(r));

test('the process is started with the source asked for, and again when it dies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawned = [];
  const live = new LiveInput({
    scriptPath: '/srv/live_input.py',
    spawner: (exe, args) => { const p = fakeProcess(); spawned.push({ args, p }); return p; },
  });
  live.start({ source: 'input', device: 'Line In (USB)' });
  assert.deepStrictEqual(spawned[0].args, ['/srv/live_input.py', '--source', 'input', '--device', 'Line In (USB)']);

  // Same source: nothing restarts. Only the latency moved.
  live.start({ source: 'input', device: 'Line In (USB)', latencyMs: -30 });
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(live._options.latencyMs, -30);

  spawned[0].p.stdout.write(`${state()}\n`);
  await new Promise((r) => setImmediate(r));
  assert.ok(live.getReading(), 'lines are read off stdout');

  spawned[0].p.stderr.write('Traceback: device unplugged\n');
  spawned[0].p.emit('close', 1);
  assert.ok(live.status().error);
  t.mock.timers.tick(2000);
  assert.strictEqual(spawned.length, 2, 'started again');

  live.start({ source: 'loopback' });
  assert.ok(spawned[1].p.killed, 'a different source replaces the process');
  assert.deepStrictEqual(spawned[2].args, ['/srv/live_input.py', '--source', 'loopback']);
  live.stop();
  assert.ok(spawned[2].p.killed);
  t.mock.timers.tick(60000);
  assert.strictEqual(spawned.length, 3, 'and stays stopped');
});

// ── Band powers ───────────────────────────────────────────────────────────────

test('band edits update the running input without restarting it', async () => {
  const procs = [];
  const live = new LiveInput({ spawner: (exe, args) => { const p = fakeProcess(); p.args = args; procs.push(p); return p; }, now: () => 0 });
  live.start({ source: 'loopback', bands: [[0, 160], [750, 2000]] });
  assert.ok(procs[0].args.join(' ').includes('--bands 0-160,750-2000'));
  live.start({ source: 'loopback', bands: [[0, 160], [750, 2000]] });
  live.start({ source: 'loopback', bands: [[20, 250]] });
  live.start({ source: 'loopback' });
  await settle();
  assert.strictEqual(procs.length, 1, 'one process throughout');
  assert.strictEqual(procs[0].killed, false);
  assert.deepStrictEqual(procs[0].asked, [{ type: 'bands', bands: '20-250' }, { type: 'bands', bands: '' }], 'same bands: nothing asked');
  assert.strictEqual(live.options.bands, undefined);
  live.stop();
});

test('the spectrum rides on the reading', () => {
  const live = new LiveInput({ spawner: () => fakeProcess(), now: () => 1000 });
  live.start({ source: 'loopback' });
  live.handleLine(JSON.stringify({ type: 'state', t: 1, captured: 1, beat: 0, bpm: 120, phase: 0, locked: true, energy: 0.1, onset: 0, flux: 0, rms: 0.1, tension: 0, bands: {}, spectrum: { power: 2, rms: 0.1, dominantHz: 1000, bands: [1, 2, 3] } }));
  assert.deepStrictEqual(live.getReading().spectrum.bands, [1, 2, 3]);
});

test('the band list is copied in and out, and no list is the same as an empty one', async () => {
  const spawned = [];
  const procs = [];
  const live = new LiveInput({ scriptPath: '/srv/live_input.py', spawner: (exe, args) => { spawned.push(args); const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  live.start({ source: 'loopback' });
  live.start({ source: 'loopback', bands: [] });
  assert.strictEqual(spawned.length, 1);
  assert.deepStrictEqual(spawned[0], ['/srv/live_input.py', '--source', 'loopback'], 'no --bands without bands');
  assert.deepStrictEqual(live.options, { source: 'loopback' });

  // Edited in place and passed again: a different list, which the copy kept at the start can tell.
  const bands = [[0, 160], [750, 2000]];
  live.start({ source: 'input', bands });
  bands[1][1] = 2500;
  live.start({ source: 'input', bands });
  await settle();
  assert.strictEqual(spawned.length, 2);
  assert.deepStrictEqual(procs[1].asked, [{ type: 'bands', bands: '0-160,750-2500' }]);

  // A file is heard with bands too, and what `options` hands out is a copy.
  const given = live.options;
  given.bands[0][0] = 20;
  assert.deepStrictEqual(live.options.bands, [[0, 160], [750, 2500]]);
  live.start({ source: 'file', file: '/music/a.wav', bands: live.options.bands });
  assert.deepStrictEqual(spawned[2], ['/srv/live_input.py', '--file', '/music/a.wav', '--realtime', '--bands', '0-160,750-2500']);
});

test('invalid band edits preserve the running input', async () => {
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  live.start({ source: 'loopback', bands: [[0, 160]] });
  const bad = [[[0, BAND_HZ_MAX + 1]], [[160, 0]], [[100, 100]], [[-1, 100]], [[0, NaN]], [[0, Infinity]], [[0]], [['0', 160]], 'x',
    Array.from({ length: MAX_BANDS + 1 }, () => [0, 100])];
  for (const bands of bad) assert.throws(() => live.start({ source: 'loopback', bands }), RangeError, JSON.stringify(bands));
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(procs[0].killed, false);
  assert.deepStrictEqual(live.options.bands, [[0, 160]]);
  live.start({ source: 'loopback', bands: Array.from({ length: MAX_BANDS }, () => [0, BAND_HZ_MAX]) });
  await settle();
  assert.strictEqual(procs.length, 1);
  assert.deepStrictEqual(procs[0].asked, [{ type: 'bands', bands: Array(MAX_BANDS).fill(`0-${BAND_HZ_MAX}`).join(',') }], 'a dozen, up to 11 025 Hz, is fine');
});

test('band sources are queried on start and refresh only changed bands', async () => {
  const spawned = [];
  const procs = [];
  const live = new LiveInput({ spawner: (exe, args) => { spawned.push(args); const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  let bands = [[20, 250], [0, 160]];
  live.useBands(() => bands);
  live.start({ source: 'loopback' });
  assert.deepStrictEqual(spawned[0].slice(-2), ['--bands', '20-250,0-160']);
  // A start from the settings brings no bands, one from before a setup the old ones.
  live.start({ source: 'loopback', latencyMs: 40 });
  live.start({ source: 'loopback', latencyMs: 40, bands: [[1, 2]] });
  assert.strictEqual(spawned.length, 1, 'the source\'s bands, still: nothing restarts');
  assert.deepStrictEqual(live.options.bands, [[20, 250], [0, 160]]);
  live.refreshBands();
  bands = [[20, 250], [0, 120]];
  live.refreshBands();
  await settle();
  assert.strictEqual(spawned.length, 1, 'the running service takes the new list');
  assert.deepStrictEqual(procs[0].asked, [{ type: 'bands', bands: '20-250,0-120' }], 'and is told of a change only');
  assert.deepStrictEqual(live.options.bands, [[20, 250], [0, 120]]);
  assert.strictEqual(live.options.latencyMs, 40, 'the rest of the options as they were');
  live.stop();
  bands = [[20, 250]];
  live.refreshBands();
  assert.strictEqual(spawned.length, 1, 'stopped: a refresh starts nothing');
  live.start(live.options);
  assert.deepStrictEqual(spawned[1].slice(-2), ['--bands', '20-250'], 'started again with the bands of now');
  live.useBands(null);
  live.start({ source: 'input', bands: [[0, 160]] });
  assert.deepStrictEqual(spawned[2].slice(-2), ['--bands', '0-160'], 'without a source, a start\'s own bands');
  live.stop();
});

test('readings switch band metadata when the service confirms the change', () => {
  const live = new LiveInput({ spawner: () => fakeProcess(), now: () => 1000 });
  live.start({ source: 'loopback', bands: [[0, 160], [750, 2000]] });
  live.handleLine(state({ spectrum: { power: 1, rms: 0.03, dominantHz: null, bands: [1, 2], fftPower: 9 } }));
  assert.strictEqual(live.getReading().layout, '0-160,750-2000');
  // Lines already on their way were summed over the old list.
  live.start({ source: 'loopback', bands: [[20, 250]] });
  live.handleLine(state({ t: 10.0116, spectrum: { power: 1, rms: 0.03, dominantHz: null, bands: [1, 2], fftPower: 9 } }));
  assert.strictEqual(live.getReading().layout, '0-160,750-2000', 'not yet taken');
  live.handleLine(JSON.stringify({ type: 'bands', bands: '20-250' }));
  live.handleLine(state({ t: 10.0232, spectrum: { power: 1, rms: 0.03, dominantHz: null, bands: [1], fftPower: 9 } }));
  assert.strictEqual(live.getReading().layout, '20-250');
  live.start({ source: 'input' });
  live.handleLine(state());
  assert.strictEqual(live.getReading().layout, '', 'none');
  live.stop();
});

test('band edits preserve process timing and envelope state', async () => {
  let now = 50000;
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => now });
  live.start({ source: 'loopback', bands: [[0, 160]] });
  live._rl.emit('line', state({ t: 600, captured: 600.01, beat: 1200, locked: true }));
  const before = live.getBeatReading();
  assert.strictEqual(before.key, 1);
  live.start({ source: 'loopback', bands: [[20, 250], [0, 160]] });
  await settle();
  assert.deepStrictEqual([procs.length, procs[0].killed], [1, false]);
  assert.deepStrictEqual(procs[0].asked, [{ type: 'bands', bands: '20-250,0-160' }]);
  assert.deepStrictEqual(live.getBeatReading(), before, 'the reading and the lock stand');
  assert.strictEqual(live.status().listening, true);
  now += 12;
  live._rl.emit('line', JSON.stringify({ type: 'bands', bands: '20-250,0-160' }));
  live._rl.emit('line', state({ t: 600.012, captured: 600.022, beat: 1200.024, locked: false }));
  const r = live.getReading();
  assert.deepStrictEqual([r.generation, r.cause, r.layout], [1, 'start', '20-250,0-160'], 'the same process, on the new bands');
  assert.strictEqual(live.getBeatReading().key, 1, 'one unlocked line is no lost lock');
  assert.ok(Math.abs(live.streamNowMs() - (600010 + 12)) < 1e-6, 'the stream sits where it did on the clock');
  assert.deepStrictEqual(live.recentEnvelope().map((e) => e.t), [600, 600.012]);
  live.stop();
});

test('a write to a process that has gone is no crash, and no error of the input\'s', () => {
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  live.start({ source: 'loopback', bands: [[0, 160]] });
  procs[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.strictEqual(live.status().error, null);
  live.stop();
});

test('readings record the reason their process started', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const procs = [];
  // Processes that take no requests: a band edit has to start one on the new list.
  const live = new LiveInput({ spawner: () => { const p = fakeProcess({ stdin: false }); procs.push(p); return p; }, now: () => 1000 });
  const causeNow = () => { live.handleLine(state()); return live.getReading().cause; };
  live.start({ source: 'loopback', bands: [[0, 160]] });
  assert.strictEqual(causeNow(), 'start');
  live.start({ source: 'loopback', bands: [[0, 120]] });
  assert.strictEqual(causeNow(), 'bands', 'only the bands changed, on a running input');
  live.start({ source: 'input', device: 'Line In', bands: [[0, 100]] });
  assert.strictEqual(causeNow(), 'input', 'another source, the bands with it');
  live.start({ source: 'input', device: 'Mic', bands: [[0, 100]] });
  assert.strictEqual(causeNow(), 'input', 'another device');
  live.start({ source: 'file', file: '/music/a.wav', bands: [[0, 100]] });
  live.start({ source: 'file', file: '/music/b.wav', bands: [[0, 100]] });
  assert.strictEqual(causeNow(), 'input', 'another file');

  // A process replaced before it wrote a line hands its cause on.
  live.start({ source: 'loopback', bands: [[0, 100]] });
  live.start({ source: 'loopback', bands: [[0, 80]] });
  assert.strictEqual(causeNow(), 'input');
  live.start({ source: 'loopback', bands: [[0, 70]] });
  assert.strictEqual(causeNow(), 'bands', 'heard in between: its own again');

  // Died: the restart, and a band edit while it waits for one, are new streams.
  procs[procs.length - 1].emit('close', 1);
  t.mock.timers.tick(2000);
  assert.strictEqual(causeNow(), 'start');
  procs[procs.length - 1].emit('close', 1);
  live.start({ source: 'loopback', bands: [[0, 60]] });
  assert.strictEqual(causeNow(), 'start');
  live.stop();
  live.start({ source: 'loopback', bands: [[0, 60]] });
  assert.strictEqual(causeNow(), 'start', 'stopped and started again');
  live.stop();
});

test('a restart after the process died asks the band source too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawned = [];
  const procs = [];
  const live = new LiveInput({ spawner: (exe, args) => { spawned.push(args); const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  let bands = [[20, 250], [0, 160]];
  live.useBands(() => bands);
  live.start({ source: 'loopback' });
  bands = [[20, 250], [0, 120]];
  procs[0].emit('close', 1);
  t.mock.timers.tick(2000);
  assert.deepStrictEqual(spawned[1].slice(-2), ['--bands', '20-250,0-120'], 'the bands of now, not of the last start');
  assert.deepStrictEqual(live.options.bands, bands);
  // A source that has gone bad does not stop the restart: the bands it had.
  live.useBands(() => [[0, 99999]]);
  procs[1].emit('close', 1);
  t.mock.timers.tick(4000);
  assert.strictEqual(spawned.length, 3);
  assert.deepStrictEqual(spawned[2].slice(-2), ['--bands', '20-250,0-120']);
  live.stop();
});

test('the band limits are the service\'s own, for a settings validator to share', () => {
  // The service refuses past these with a usage error and an exit, so a
  // validator that drifted from them would keep the process failing.
  const py = fs.readFileSync(new URL('../../src/analysis/live.py', import.meta.url), 'utf8');
  assert.strictEqual(MAX_BANDS, Number(/^MAX_BANDS = (\d+)$/m.exec(py)[1]));
  assert.strictEqual(BAND_HZ_MAX, Number(/^SAMPLE_RATE = (\d+)$/m.exec(py)[1]) / 2);
  assert.match(py, /^BAND_HZ_MAX = SAMPLE_RATE \/ 2\.0$/m);
});

test('a reading says which process it came from, and a replaced process is not heard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => 1000 });
  live.start({ source: 'loopback', bands: [[0, 160]] });
  const firstLines = live._rl;
  const spectrum = { power: 0.5, rms: 0.022, dominantHz: 990.52734375, bands: [3.5e-6], fftPower: 120 };
  firstLines.emit('line', state({ t: 1, spectrum }));
  assert.strictEqual(live.getReading().generation, 1);
  assert.deepStrictEqual(live.getReading().spectrum, spectrum, 'raw Σx² and the FFT total both arrive as written');

  // Another input is a new process. Nothing from the old one counts any
  // more: its lines were summed over the old bands, and a late error from it
  // must not restart the new one.
  live.start({ source: 'input', bands: [[20, 250]] });
  firstLines.emit('line', state({ t: 2, spectrum: { power: 1, rms: 0.03, dominantHz: null, bands: [5], fftPower: 9 } }));
  assert.strictEqual(live.getReading(), null);
  procs[0].emit('error', new Error('late'));
  assert.strictEqual(live.status().error, null);
  live._rl.emit('line', state({ t: 3 }));
  assert.deepStrictEqual([live.getReading().t, live.getReading().generation], [3, 2]);

  // One that dies and is started again is a new process too.
  procs[1].emit('close', 1);
  t.mock.timers.tick(2000);
  live._rl.emit('line', state({ t: 0.5 }));
  assert.deepStrictEqual([procs.length, live.getReading().generation], [3, 3]);
  live.stop();
});

test('a replaced process is not heard, nor its late error', () => {
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => 50000 });
  live.start({ source: 'input' });
  const firstLines = live._rl;
  live.start({ source: 'loopback' });
  assert.strictEqual(procs.length, 2);

  // Closing the old reader does not stop lines it already holds.
  firstLines.emit('line', state());
  assert.strictEqual(live.getReading(), null);
  procs[0].emit('error', new Error('late'));
  assert.strictEqual(live.status().error, null, 'the new process carries on');
  assert.strictEqual(procs.length, 2);
  live.stop();
});

test('a process that dies takes its stream clock, lock and envelope with it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 50000;
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => now });
  live.start({ source: 'loopback' });
  // Ten minutes in and locked: stream time 600.01 s arrives at 50 000 ms.
  live._rl.emit('line', state({ t: 600, captured: 600.01, beat: 1200, locked: true }));
  assert.ok(Math.abs(live.streamNowMs() - 600010) < 1e-6);
  assert.deepStrictEqual(live.recentEnvelope().map((e) => e.t), [600]);

  procs[0].emit('close', 1);
  now += 2000;
  t.mock.timers.tick(2000);
  assert.strictEqual(procs.length, 2, 'started again');

  // The new process counts its stream from zero. The dead one's lock does not
  // vouch for a grid it never heard, its arrivals do not place the new stream
  // on the clock, and its levels are not the new stream's envelope.
  now += 500;
  live._rl.emit('line', state({ t: 0.5, captured: 0.512, beat: 1.0, locked: false }));
  assert.strictEqual(live.getBeatReading(), null, 'unlocked, and the old lock is gone');
  now += 100;
  live._rl.emit('line', state({ t: 0.6, captured: 0.612, beat: 1.2, locked: true }));
  assert.ok(Math.abs(live.streamNowMs() - 612) < 1e-6, `stream now ${live.streamNowMs()}`);
  assert.ok(Math.abs(live.getBeatReading().beatPos - (1.2 + 0.012 * 2)) < 1e-9, `beat ${live.getBeatReading().beatPos}`);
  assert.deepStrictEqual(live.recentEnvelope().map((e) => e.t), [0.5, 0.6]);
  live.stop();
});

test('the devices come from the service, and a failure says why', async () => {
  const withOutput = (out, code = 0, err = '') => () => {
    const p = fakeProcess();
    setImmediate(() => { p.stdout.write(out); p.stderr.write(err); p.stdout.end(); p.emit('close', code); });
    return p;
  };
  const listed = await listLiveDevices({ spawner: withOutput(`${JSON.stringify({
    type: 'devices', backend: 'soundcard', outputs: ['Speakers'], inputs: ['Line In'], defaultOutput: 'Speakers', defaultInput: null,
  })}\n`) });
  assert.deepStrictEqual(listed, { backend: 'soundcard', outputs: ['Speakers'], inputs: ['Line In'], defaultOutput: 'Speakers', defaultInput: null });
  await assert.rejects(listLiveDevices({ spawner: withOutput('', 1, 'ModuleNotFoundError: No module named numpy\n') }));
});

// ── The pattern clock ─────────────────────────────────────────────────────────

test('the pattern clock follows the live beat when nothing better knows the music', () => {
  let now = 1000;
  const conductor = new Conductor({ now: () => now, bpm: 100 });
  let live = { beatPos: 12.25, bpm: 126 };
  conductor.setLiveSource(() => live);
  assert.deepStrictEqual((({ source, beatPos, bpm }) => ({ source, beatPos, bpm }))(conductor.now()), { source: 'live', beatPos: 12.25, bpm: 126 });

  // A known track outranks it; the show's grid and a deck do too.
  const grid = makeGrid(Array.from({ length: 64 }, (_, i) => i * 0.5));
  conductor.setTrack({ key: 'x', grid, positionMs: () => 4000 + (now - 1000) });
  now += 10;
  assert.strictEqual(conductor.now().source, 'track');
  conductor.clearTrack();
  conductor.setProlinkSource(() => ({ beatPos: 3, bpm: 128 }));
  assert.strictEqual(conductor.now().source, 'cdj');
  conductor.setProlinkSource(null);

  // Lost: the free clock carries on from where the live beat was.
  now += 10;
  assert.strictEqual(conductor.now().source, 'live');
  live = null;
  now += 500;
  const free = conductor.now();
  assert.strictEqual(free.source, 'tap');
  assert.strictEqual(free.bpm, 126, 'at the tempo it heard');
});
