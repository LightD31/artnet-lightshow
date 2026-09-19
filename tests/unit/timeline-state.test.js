'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let timeline;
test.before(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public-src/timeline-state.js'), 'utf8');
  timeline = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
});

test('timeline position only extrapolates a live clock briefly', () => {
  assert.equal(timeline.timelinePosition({ positionMs: 1000, running: false }, 1200, 2000), 1000);
  assert.equal(timeline.timelinePosition({ positionMs: 1000, running: true, advancing: true, updatedAt: 900 }, 1200, 2000), 1250);
  assert.equal(timeline.timelinePosition({ positionMs: 1000, running: true, advancing: true, updatedAt: 900 }, 5000, 2000), 1250);
  assert.equal(timeline.timelinePosition({ positionMs: -5, running: false }, 0, 2000), 0);
});

test('a cancelled timeline request cannot publish a late response', async () => {
  let resolveFetch;
  const states = [];
  const request = timeline.loadTimeline('rev-1', (state) => states.push(state), {
    fetcher: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  assert.equal(states[0].status, 'loading');
  request.cancel();
  resolveFetch({ ok: true, json: async () => ({ ok: true, data: { revision: 'rev-1' } }) });
  await request.done;
  assert.deepEqual(states.map((state) => state.status), ['loading']);
});

test('a timeline response with a newer revision becomes a retryable error', async () => {
  const states = [];
  const request = timeline.loadTimeline('rev-1', (state) => states.push(state), {
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true, data: { revision: 'rev-2' } }) }),
  });
  await request.done;
  assert.equal(states.at(-1).status, 'error');
  assert.match(states.at(-1).error, /changed/i);
});

test('a request timeout publishes an error and aborts its fetch', async () => {
  const states = [];
  const request = timeline.loadTimeline('rev-1', (state) => states.push(state), {
    timeoutMs: 5,
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await request.done;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(states.at(-1).status, 'error');
  assert.match(states.at(-1).error, /timed out/i);
});

test('timeline keys use the server revision and remain stable without one', () => {
  assert.equal(timeline.timelineKey({ autoShow: { analysis: {}, timelineRevision: 'abc' } }), 'abc');
  const state = { autoShow: { analysis: { duration: 20 }, track: { name: 'Song', artist: 'Artist' }, timelineLength: 10, intensity: 50, palette: [1, 2] } };
  assert.equal(timeline.timelineKey(state), timeline.timelineKey(JSON.parse(JSON.stringify(state))));
});
