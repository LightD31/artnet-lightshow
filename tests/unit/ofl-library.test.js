// The Open Fixture Library online, against a stand-in for its web API, and
// the routes the settings page calls, mounted on a real Express app.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import { createOflLibrary } from '../../src/server/ofl-library.ts';
import { attachRoutes } from '../../src/server/routes.ts';

const ORIGIN = 'https://open-fixture-library.org';
const STAIRVILLE = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'ofl', 'stairville_led-bar-240-8.json'), 'utf8');

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** A fake library: `routes` maps "METHOD path" to a response maker. Records every request. */
function fakeLibrary(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, origin: u.origin, body: init.body, redirect: init.redirect, signal: init.signal });
    const route = routes[key];
    if (!route) return json({ error: 'not found' }, { status: 404 });
    return route(init);
  };
  return { fetchImpl, calls };
}

const SEARCH = 'POST /api/v1/get-search-results';

test('a search names what it finds, from each maker\'s list', async () => {
  const { fetchImpl, calls } = fakeLibrary({
    [SEARCH]: () => json(['stairville/led-bar-240-8', 'showtec/pixel-bar-12-mkii', 'stairville/gone', '../etc/passwd', 42]),
    'GET /api/v1/manufacturers/stairville': () => json({ name: 'Stairville', fixtures: [{ key: 'led-bar-240-8', name: 'LED Bar 240/8', categories: ['Pixel Bar', 'Color Changer'] }] }),
    'GET /api/v1/manufacturers/showtec': () => json({ error: 'down' }, { status: 500 }),
  });
  const library = createOflLibrary({ fetchImpl });
  const hits = await library.search('  bar ');
  assert.deepStrictEqual(JSON.parse(calls[0].body), { searchQuery: 'bar', manufacturersQuery: [], categoriesQuery: [] });
  assert.ok(calls.every((c) => c.origin === ORIGIN));
  assert.deepStrictEqual(hits, [
    { manufacturerKey: 'stairville', fixtureKey: 'led-bar-240-8', manufacturer: 'Stairville', name: 'LED Bar 240/8', categories: ['Pixel Bar', 'Color Changer'] },
    // A maker whose list fails shows its keys rather than failing the search.
    { manufacturerKey: 'showtec', fixtureKey: 'pixel-bar-12-mkii', manufacturer: 'showtec', name: 'pixel-bar-12-mkii', categories: [] },
    { manufacturerKey: 'stairville', fixtureKey: 'gone', manufacturer: 'Stairville', name: 'gone', categories: [] },
  ]);
});

test('a maker\'s list is fetched once an hour, and not kept when it failed', async () => {
  let clock = 0;
  let listFails = true;
  const { fetchImpl, calls } = fakeLibrary({
    [SEARCH]: () => json(['stairville/led-bar-240-8']),
    'GET /api/v1/manufacturers/stairville': () => (listFails ? json({}, { status: 503 }) : json({ name: 'Stairville', fixtures: [] })),
  });
  const library = createOflLibrary({ fetchImpl, now: () => clock });
  const lists = () => calls.filter((c) => c.key.includes('manufacturers')).length;
  await library.search('bar');
  listFails = false;
  await library.search('bar');
  await library.search('bar');
  assert.strictEqual(lists(), 2, 'the failure was asked again, the success was kept');
  clock += 61 * 60 * 1000;
  await library.search('bar');
  assert.strictEqual(lists(), 3, 'an hour later it is asked again');
});

test('a fixture is fetched by its keys and read, with its maker\'s name', async () => {
  const { fetchImpl, calls } = fakeLibrary({
    'GET /stairville/led-bar-240-8.json': () => new Response(STAIRVILLE, { status: 200 }),
    'GET /api/v1/manufacturers/stairville': () => json({ name: 'Stairville', fixtures: [] }),
  });
  const fixture = await createOflLibrary({ fetchImpl }).fixture('stairville', 'led-bar-240-8');
  assert.strictEqual(fixture.name, 'LED Bar 240/8');
  assert.strictEqual(fixture.manufacturer, 'Stairville');
  assert.strictEqual(fixture.modes.find((m) => m.modeName === '24-channel').cells.length, 8);
  assert.ok(calls.every((c) => c.redirect === 'manual' && c.signal instanceof AbortSignal));
});

test('keys that are not OFL keys never reach the network', async () => {
  const { fetchImpl, calls } = fakeLibrary({});
  const library = createOflLibrary({ fetchImpl });
  for (const [maker, key] of [['..', 'x'], ['cameo', 'root par'], ['Cameo', 'x'], ['cameo', 'a/b'], ['cameo', ''], ['-x', 'y']]) {
    await assert.rejects(library.fixture(maker, key), (err) => err.status === 400, `${maker}/${key}`);
  }
  await assert.rejects(library.search('x'), (err) => err.status === 400);
  await assert.rejects(library.search('x'.repeat(101)), (err) => err.status === 400);
  assert.strictEqual(calls.length, 0);
});

test('a renamed fixture\'s redirect is followed within the library, and nowhere else', async () => {
  const moved = (location) => () => new Response(null, { status: 301, headers: { location } });
  const { fetchImpl } = fakeLibrary({
    'GET /stairville/old-name.json': moved('/stairville/led-bar-240-8.json'),
    'GET /stairville/led-bar-240-8.json': () => new Response(STAIRVILLE),
    'GET /stairville/elsewhere.json': moved('http://169.254.169.254/latest/meta-data'),
  });
  const library = createOflLibrary({ fetchImpl });
  assert.strictEqual((await library.fixture('stairville', 'old-name')).name, 'LED Bar 240/8');
  await assert.rejects(library.fixture('stairville', 'elsewhere'), (err) => err.status === 502 && /redirected somewhere else/.test(err.message));
});

test('what the library answers is bounded and checked', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const { fetchImpl } = fakeLibrary({
    'GET /big/declared.json': () => new Response('{}', { headers: { 'content-length': String(big.length) } }),
    'GET /big/streamed.json': () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new TextEncoder().encode(big.slice(0, 1024 * 1024)));
        controller.close();
      },
    })),
    'GET /bad/html.json': () => new Response('<html>'),
    'GET /bad/notofl.json': () => json({ hello: 'world' }),
  });
  const library = createOflLibrary({ fetchImpl });
  await assert.rejects(library.fixture('big', 'declared'), (err) => err.status === 502 && /more than 2 MB/.test(err.message));
  await assert.rejects(library.fixture('big', 'streamed'), (err) => err.status === 502 && /more than 2 MB/.test(err.message));
  await assert.rejects(library.fixture('bad', 'html'), (err) => err.status === 502 && /not JSON/.test(err.message));
  await assert.rejects(library.fixture('bad', 'notofl'), (err) => err.status === 400);
  await assert.rejects(library.fixture('bad', 'missing'), (err) => err.status === 404);
});

test('offline or slow, it says so and points at the file import', async () => {
  const offline = createOflLibrary({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND open-fixture-library.org') }); } });
  await assert.rejects(offline.search('bar'), (err) => err.status === 502 && /Cannot reach the Open Fixture Library \(fetch failed: getaddrinfo ENOTFOUND/.test(err.message) && /downloaded OFL file/.test(err.message));
  const slow = createOflLibrary({ fetchImpl: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  await assert.rejects(slow.search('bar'), (err) => err.status === 504 && /did not answer within 10 s/.test(err.message));
});

// ── The routes ──────────────────────────────────────────────────────────────

async function withApp(oflLibrary, fn) {
  const app = express();
  app.use(express.json());
  attachRoutes(app, { integrations: { broadcast() {} }, oflLibrary });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const upload = (content, name = 'fixture.json', manufacturer) => {
  const form = new FormData();
  form.append('ofl', new Blob([content], { type: 'application/json' }), name);
  if (manufacturer) form.append('manufacturer', manufacturer);
  return { method: 'POST', body: form };
};

test('POST /api/ofl/parse reads an uploaded file, offline', async () => {
  await withApp(null, async (call) => {
    const ok = await call('/api/ofl/parse', upload(STAIRVILLE, 'led-bar-240-8.json', 'Stairville'));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.fixture.manufacturer, 'Stairville');
    assert.strictEqual(ok.body.fixture.modes.length, 4);

    const unnamed = await call('/api/ofl/parse', upload(STAIRVILLE));
    assert.strictEqual(unnamed.body.fixture.manufacturer, 'Unknown');

    const notJson = await call('/api/ofl/parse', upload('<GDTF/>'));
    assert.strictEqual(notJson.status, 400);
    assert.match(notJson.body.error, /not JSON/);

    const notOfl = await call('/api/ofl/parse', upload('{"name":"x"}'));
    assert.strictEqual(notOfl.status, 400);
    assert.match(notOfl.body.error, /OFL file: modes/);

    const none = await call('/api/ofl/parse', { method: 'POST' });
    assert.strictEqual(none.status, 400);
  });
});

test('GET /api/ofl/search and /api/ofl/fixture answer from the library, errors included', async () => {
  const asked = [];
  const library = {
    async search(q) { asked.push(['search', q]); return [{ manufacturerKey: 'a', fixtureKey: 'b', manufacturer: 'A', name: 'B', categories: [] }]; },
    async fixture(maker, key) {
      asked.push(['fixture', maker, key]);
      throw Object.assign(new Error('The Open Fixture Library has no such fixture'), { status: 404 });
    },
  };
  await withApp(library, async (call) => {
    const found = await call('/api/ofl/search?q=pixel%20bar');
    assert.deepStrictEqual(found, { status: 200, body: { ok: true, results: [{ manufacturerKey: 'a', fixtureKey: 'b', manufacturer: 'A', name: 'B', categories: [] }] } });
    const missing = await call('/api/ofl/fixture/cameo/nope');
    assert.deepStrictEqual(missing, { status: 404, body: { ok: false, error: 'The Open Fixture Library has no such fixture' } });
  });
  assert.deepStrictEqual(asked, [['search', 'pixel bar'], ['fixture', 'cameo', 'nope']]);
});
