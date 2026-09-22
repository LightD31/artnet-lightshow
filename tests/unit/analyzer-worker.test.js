'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const AnalyzerWorker = require('../../src/analyzer-worker');

const FAKE = path.join(__dirname, '..', 'helpers', 'fake-analyzer.js');
const worker = (mode, opts) => {
  process.env.FAKE_MODE = mode;
  return new AnalyzerWorker(process.execPath, FAKE, opts);
};

test('analyses are dispatched and resolved', async () => {
  const w = worker('ok');
  try {
    assert.deepStrictEqual(await w.analyze('/tmp/a.wav', null), { bpm: 128, source: '/tmp/a.wav' });
  } finally { w.shutdown(); }
});

test('high priority jumps the queue ahead of normal work', () => {
  const w = worker('ok');
  try {
    // Inspect ordering without dispatching: submit against a not-yet-spawned
    // worker and read the queue the scheduler built.
    const q = [];
    const stub = (id, priority, tag) => ({ id, priority, tag, resolve() {}, reject() {} });
    w._insertByPriority(stub(1, 'normal', 'n1'));
    w._insertByPriority(stub(2, 'normal', 'n2'));
    w._insertByPriority(stub(3, 'high', 'h1'));
    for (const e of w._queue) q.push(e.tag);
    assert.deepStrictEqual(q, ['h1', 'n1', 'n2'], 'high first, normals keep FIFO order');

    w.promote('n2');
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['h1', 'n2', 'n1'], 'promoted behind existing highs');

    w._insertByPriority(stub(4, 'current', 'c1'));
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['c1', 'h1', 'n2', 'n1'], 'the playing song leads');

    // An interrupted job goes back at the head of its own band, not the tail:
    // it has already done work that its peers have not.
    w._insertByPriority(stub(5, 'normal', 'n0'), { front: true });
    // n2 was promoted to high above, so n0 leads the normals.
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['c1', 'h1', 'n2', 'n0', 'n1']);
  } finally { w.shutdown(); }
});

// Depth-5 prefetching submitted five tracks into one band, so the track the
// listener hears next could wait behind four it would only reach minutes later.
test('within a band, the playback queue order is the serving order', () => {
  const w = worker('ok');
  try {
    const stub = (id, priority, tag, order) => ({ id, priority, tag, order, resolve() {}, reject() {} });
    w._insertByPriority(stub(1, 'normal', 'slot2', 2));
    w._insertByPriority(stub(2, 'normal', 'slot0', 0));
    w._insertByPriority(stub(3, 'normal', 'slot1', 1));
    // A set-list warm job has no place in the queue, so it waits behind it.
    w._insertByPriority(stub(4, 'normal', 'warm'));
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['slot0', 'slot1', 'slot2', 'warm']);

    // Two tracks at the same position (a warm job and an unqueued file) keep
    // the order they arrived in.
    w._insertByPriority(stub(5, 'normal', 'file'));
    assert.deepStrictEqual(w._queue.map((e) => e.tag).slice(-2), ['warm', 'file']);
  } finally { w.shutdown(); }
});

// The queue reshapes while prefetches wait: the listener queues a song, skips
// one, or a radio rebuilds the tail. A prefetch submitted when its track was
// fourth in line was still analysed fourth, holding up the new next track.
test('a reshaped queue re-ranks the prefetches still waiting', () => {
  const w = worker('ok');
  try {
    const stub = (id, priority, tag, order) => ({ id, priority, tag, order, resolve() {}, reject() {} });
    w._insertByPriority(stub(1, 'current', 'playing'));
    w._insertByPriority(stub(2, 'normal', 'a', 0));
    w._insertByPriority(stub(3, 'normal', 'b', 1));
    w._insertByPriority(stub(4, 'normal', 'c', 2));
    w._insertByPriority(stub(5, 'normal', 'warm'));

    // 'b' was pushed to the front of the queue and 'a' was dropped from it.
    w.setQueueOrder(['b', 'c']);
    // 'a' lands behind the whole queue, level with the warm job that has no
    // place in it either, and the two tie back to the order they arrived in.
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['playing', 'b', 'c', 'a', 'warm'],
      'the playing song keeps the head, the dropped track falls behind the queue');

    // An unknown order leaves the queue as it stands.
    w.setQueueOrder(null);
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['playing', 'b', 'c', 'a', 'warm']);
  } finally { w.shutdown(); }
});

// The queue position travels with the request, not just with a later re-rank.
test('a queue position submitted with the analysis is honoured', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  const deep = w.analyze('/tmp/deep.wav', null, { priority: 'normal', tag: 'deep', queuePos: 3 });
  const next = w.analyze('/tmp/next.wav', null, { priority: 'normal', tag: 'next', queuePos: 0 });
  deep.catch(() => { /* settled by the shutdown below */ });
  next.catch(() => { /* settled by the shutdown below */ });
  try {
    assert.strictEqual(w._pending.tag, 'deep', 'the first submission is already running');
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['next'], 'and the nearer track leads the queue');

    // Running work is not interrupted for a mere queue position — only the
    // song playing right now is worth throwing away work for.
    const third = w.analyze('/tmp/third.wav', null, { priority: 'normal', tag: 'third', queuePos: 1 });
    third.catch(() => { /* settled by the shutdown below */ });
    assert.strictEqual(w._pending.tag, 'deep');
    assert.deepStrictEqual(w._queue.map((e) => e.tag), ['next', 'third']);
  } finally { w.shutdown(); }
});

// Priority ordering alone still left the playing song behind a prefetch that
// had started moments earlier — a minute of darkness with the show queued up
// behind work nobody was waiting for.
test('the playing song interrupts a prefetch that is already running', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  const slow = w.analyze('/tmp/slow.wav', null, { priority: 'normal', tag: 'slow' });
  slow.catch(() => { /* settled by the shutdown below */ });
  assert.strictEqual(w._pending.tag, 'slow', 'prefetch is in flight');

  const now = await w.analyze('/tmp/now.wav', null, { priority: 'current', tag: 'now' });
  assert.deepStrictEqual(now, { bpm: 128, source: '/tmp/now.wav' }, 'served without waiting');
  assert.strictEqual(w._pending.tag, 'slow', 'the interrupted prefetch resumes after it');

  w.shutdown();
  await assert.rejects(slow, /shutting down|worker/);
});

// Only one song plays at a time, so an analysis still running when the track
// changes is for a track the room has left behind. Finishing it would hand the
// previous song's timeline to the show that just started.
test('a newer playing song supersedes the analysis it replaced', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  try {
    const first = w.analyze('/tmp/slow.wav', null, { priority: 'current', tag: 'a' });
    const second = w.analyze('/tmp/now.wav', null, { priority: 'current', tag: 'b' });
    await assert.rejects(first, (err) => err.superseded === true);
    assert.deepStrictEqual(await second, { bpm: 128, source: '/tmp/now.wav' });
    assert.strictEqual(w._queue.length, 0, 'the superseded job is not requeued');
  } finally { w.shutdown(); }
});

// The prefetch that was running turns out to be the song that just started:
// restarting it would throw away everything it has done.
test('a prefetch of the song that just started is left running', () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  const p = w.analyze('/tmp/slow.wav', null, { priority: 'normal', tag: 'k1' });
  p.catch(() => { /* settled by the shutdown below */ });
  try {
    const proc = w._proc;
    w.promote('k1', 'current');
    assert.strictEqual(w._proc, proc, 'same process, same analysis');
    assert.strictEqual(w._pending.tag, 'k1');
  } finally { w.shutdown(); }
});

// With no timeout a wedged worker left the request unsettled
// forever and every queued prefetch stalled behind it.
test('a hung worker times out instead of stalling the queue', async () => {
  const w = worker('hang', { timeoutMs: 400 });
  try {
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
    // The queue survives: a second request runs on a fresh process.
    await assert.rejects(w.analyze('/tmp/b.wav', null), /timed out/);
  } finally { w.shutdown(); }
});

// A mismatched id was logged and then delivered anyway, handing
// one track's analysis to a different track's caller.
test('a stale response is discarded, not delivered to the wrong caller', async () => {
  const w = worker('wrongid', { timeoutMs: 400 });
  try {
    // The reply carries the wrong id, so the caller must not receive it.
    await assert.rejects(w.analyze('/tmp/a.wav', null), /timed out/);
  } finally { w.shutdown(); }
});

test('shutdown rejects work rather than leaving it pending', async () => {
  const w = worker('hang');
  const p = w.analyze('/tmp/a.wav', null);
  w.shutdown();
  await assert.rejects(p, /shutting down|worker/);
});

// A worker whose GPU FFT faulted answers its track and asks to be replaced:
// every later GPU call in that process fails too. The next request must go to
// a fresh process, and the queue behind it must survive the swap.
test('a worker that asks to be recycled is replaced before the next request', async () => {
  const w = worker('gpufault');
  try {
    const [first, second] = await Promise.all([w.analyze('/tmp/a.wav', null), w.analyze('/tmp/b.wav', null)]);
    assert.ok(first.pid && second.pid, 'both requests answered');
    assert.notStrictEqual(first.pid, second.pid, 'the second track went to a new process');
  } finally { w.shutdown(); }
});

// The settings page's Separator reaches Python as ARTNET_USE_BS_ROFORMER,
// read when the worker starts.
test('the worker is started with the separator the settings page chose', async () => {
  const { settings } = require('../../src/server/settings');
  const original = settings._values.analysis.separator;
  try {
    for (const [separator, flag] of [['demucs', '0'], ['bs-roformer', '1']]) {
      settings._values.analysis.separator = separator;
      const w = worker('env');
      try {
        assert.strictEqual((await w.analyze('/tmp/a.wav', null)).separator, flag, separator);
      } finally { w.shutdown(); }
    }
  } finally {
    settings._values.analysis.separator = original;
  }
});

// Changing the separator (or the interpreter) restarts the worker. Work that
// was running must go to the new process, not sit on the killed one until the
// timeout.
test('a restart hands the running analysis to the new worker', async () => {
  const w = worker('hangslow');
  try {
    const slow = w.analyze('/tmp/slow.wav', null);
    slow.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const before = w._proc.pid;
    const running = w._pending;
    w.restart('separator changed');
    assert.ok(w._proc && w._proc.pid !== before, 'a new process was started');
    assert.strictEqual(w._pending, running, 'the same request is in flight on it');
  } finally { w.shutdown(); }
});

// Two track changes in quick succession recycle two workers before either has
// died. The old single "recycling" flag let the second death clear the *new*
// worker, rejecting the current track and orphaning a process.
test('two quick recycles do not take down the worker that replaced them', async () => {
  const w = worker('hangslow', { timeoutMs: 5000 });
  try {
    const first = w.analyze('/tmp/slow-a.wav', null, { priority: 'current', tag: 'a' });
    first.catch(() => {});
    const second = w.analyze('/tmp/slow-b.wav', null, { priority: 'current', tag: 'b' });
    second.catch(() => {});
    const third = w.analyze('/tmp/late-c.wav', null, { priority: 'current', tag: 'c' });
    const result = await third;
    assert.strictEqual(result.source, '/tmp/late-c.wav');
    assert.ok(w._proc && w._proc.pid === result.pid, 'the worker that answered is still the live one');
    await assert.rejects(first, /superseded/);
    await assert.rejects(second, /superseded/);
  } finally { w.shutdown(); }
});

// A reply with a bare NaN is valid Python output and unreadable JSON. It used
// to be logged as chatter while the request waited out the timeout.
test('an unreadable reply fails its request at once instead of timing out', async () => {
  const w = worker('nanreply', { timeoutMs: 20000 });
  try {
    const started = Date.now();
    await assert.rejects(w.analyze('/tmp/a.wav', null), /unreadable/);
    assert.ok(Date.now() - started < 5000, 'did not wait for the timeout');
  } finally { w.shutdown(); }
});

// Writing to a worker that has already died raises EPIPE on its stdin. With
// no listener that is an unhandled 'error' event, and it ends the server.
test('a worker that dies at once rejects the request without crashing the server', async () => {
  const w = worker('exitnow', { timeoutMs: 5000 });
  try {
    await assert.rejects(w.analyze('/tmp/a.wav', null), /exited|write|worker/);
  } finally { w.shutdown(); }
});
