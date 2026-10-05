// The live input from the server's side: a Python process that hears the music
// writes a line every hop, and the server reads those lines onto its own clock
// — the beat for "now", not for the last hop — keeps the process alive, and
// lets the pattern clock follow what it hears when nothing else knows the track.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import LiveInput, { BAND_HZ_MAX, listLiveDevices } from '../../src/live-input.ts';
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
  assert.match(c.live.status().error, /pip install soundcard/);
});

// ── The process ───────────────────────────────────────────────────────────────

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; proc.emit('close', null); };
  return proc;
}

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
  assert.match(live.status().error, /exited \(code 1\): Traceback: device unplugged/);
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

test('bands are passed to the service and a changed list restarts it', () => {
  const spawned = [];
  const live = new LiveInput({ spawner: (exe, args) => { spawned.push(args); return fakeProcess(); }, now: () => 0 });
  live.start({ source: 'loopback', bands: [[0, 160], [750, 2000]] });
  assert.ok(spawned[0].join(' ').includes('--bands 0-160,750-2000'));
  live.start({ source: 'loopback', bands: [[0, 160], [750, 2000]] });
  assert.strictEqual(spawned.length, 1, 'same bands: no restart');
  live.start({ source: 'loopback', bands: [[20, 250]] });
  assert.strictEqual(spawned.length, 2);
});

test('the spectrum rides on the reading', () => {
  const live = new LiveInput({ spawner: () => fakeProcess(), now: () => 1000 });
  live.start({ source: 'loopback' });
  live.handleLine(JSON.stringify({ type: 'state', t: 1, captured: 1, beat: 0, bpm: 120, phase: 0, locked: true, energy: 0.1, onset: 0, flux: 0, rms: 0.1, tension: 0, bands: {}, spectrum: { power: 2, rms: 0.1, dominantHz: 1000, bands: [1, 2, 3] } }));
  assert.deepStrictEqual(live.getReading().spectrum.bands, [1, 2, 3]);
});

test('the band list is copied in and out, and no list is the same as an empty one', () => {
  const spawned = [];
  const live = new LiveInput({ scriptPath: '/srv/live_input.py', spawner: (exe, args) => { spawned.push(args); return fakeProcess(); }, now: () => 0 });
  live.start({ source: 'loopback' });
  live.start({ source: 'loopback', bands: [] });
  assert.strictEqual(spawned.length, 1);
  assert.deepStrictEqual(spawned[0], ['/srv/live_input.py', '--source', 'loopback'], 'no --bands without bands');
  assert.deepStrictEqual(live.options, { source: 'loopback' });

  // Edited in place and passed again: a different list, which the copy kept at the start can tell.
  const bands = [[0, 160], [750, 2000]];
  live.start({ source: 'loopback', bands });
  bands[1][1] = 2500;
  live.start({ source: 'loopback', bands });
  assert.strictEqual(spawned.length, 3);
  assert.deepStrictEqual(spawned[2].slice(-2), ['--bands', '0-160,750-2500']);

  // A file is heard with bands too, and what `options` hands out is a copy.
  const given = live.options;
  given.bands[0][0] = 20;
  assert.deepStrictEqual(live.options.bands, [[0, 160], [750, 2500]]);
  live.start({ source: 'file', file: '/music/a.wav', bands: live.options.bands });
  assert.deepStrictEqual(spawned[3], ['/srv/live_input.py', '--file', '/music/a.wav', '--realtime', '--bands', '0-160,750-2500']);
});

test('a band list the service would refuse throws, and the running process is left alone', () => {
  const procs = [];
  const live = new LiveInput({ spawner: () => { const p = fakeProcess(); procs.push(p); return p; }, now: () => 0 });
  live.start({ source: 'loopback', bands: [[0, 160]] });
  const bad = [[[0, BAND_HZ_MAX + 1]], [[160, 0]], [[100, 100]], [[-1, 100]], [[0, NaN]], [[0, Infinity]], [[0]], [['0', 160]], 'x',
    Array.from({ length: 13 }, () => [0, 100])];
  for (const bands of bad) assert.throws(() => live.start({ source: 'loopback', bands }), RangeError, JSON.stringify(bands));
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(procs[0].killed, false);
  assert.deepStrictEqual(live.options.bands, [[0, 160]]);
  live.start({ source: 'loopback', bands: Array.from({ length: 12 }, () => [0, BAND_HZ_MAX]) });
  assert.strictEqual(procs.length, 2, 'a dozen, up to 11 025 Hz, is fine');
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

  // A new band list is a new process. Nothing from the old one counts any
  // more: its lines were summed over the old bands, and a late error from it
  // must not restart the new one.
  live.start({ source: 'loopback', bands: [[20, 250]] });
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
  await assert.rejects(listLiveDevices({ spawner: withOutput('', 1, 'ModuleNotFoundError: No module named numpy\n') }),
    /could not list the audio devices \(exit 1\): ModuleNotFoundError: No module named numpy/);
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
