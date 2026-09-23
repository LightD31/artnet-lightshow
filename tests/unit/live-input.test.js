// The live input from the server's side: a Python process that hears the music
// writes a line every hop, and the server reads those lines onto its own clock
// — the beat for "now", not for the last hop — keeps the process alive, and
// lets the pattern clock follow what it hears when nothing else knows the track.

import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import LiveInput, { listLiveDevices } from '../../src/live-input.ts';
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
