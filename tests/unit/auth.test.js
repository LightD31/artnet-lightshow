'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAuth, configError, isLoopbackHost, originAllowed, safeEqual } = require('../../src/server/auth');

test('loopback hosts are recognised', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST']) {
    assert.strictEqual(isLoopbackHost(h), true, h);
  }
  for (const h of ['0.0.0.0', '192.168.1.10', '', undefined]) {
    assert.strictEqual(isLoopbackHost(h), false, String(h));
  }
});

test('safeEqual compares without throwing on length mismatch', () => {
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('abc', 'much longer value'), false);
  assert.strictEqual(safeEqual('', ''), true);
  assert.strictEqual(safeEqual(undefined, 'x'), false);
});

// Exposing the rig to the network with no token must be refused,
// not silently allowed.
test('a non-loopback bind without a token is refused at startup', () => {
  assert.strictEqual(configError({ host: '127.0.0.1', token: '' }), null);
  assert.strictEqual(configError({ host: '0.0.0.0', token: 'secret' }), null);

  const err = configError({ host: '0.0.0.0', token: '' });
  assert.ok(err, 'must refuse');
  assert.match(err, /LIGHTSHOW_TOKEN/);
});

// Cross-site requests are rejected whether or not a token is set,
// because several control routes take no body and skip preflight.
test('origin check rejects other websites but allows same-origin and extensions', () => {
  const req = (origin) => ({ headers: { host: 'localhost:3000', origin } });

  assert.strictEqual(originAllowed(req(undefined)), true, 'no Origin (curl, Companion)');
  assert.strictEqual(originAllowed(req('http://localhost:3000')), true, 'same origin');
  assert.strictEqual(originAllowed(req('moz-extension://abc')), true, 'firefox extension');
  assert.strictEqual(originAllowed(req('chrome-extension://abc')), true, 'chrome extension');

  assert.strictEqual(originAllowed(req('https://evil.example')), false);
  assert.strictEqual(originAllowed(req('http://localhost:9999')), false, 'different port');
  assert.strictEqual(originAllowed(req('garbage')), false);
});

test('token middleware accepts header or query, rejects wrong and missing', () => {
  const auth = createAuth({ token: 'sesame' });
  const run = (req) => {
    let status = null; let body = null; let nexted = false;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    auth.httpMiddleware(req, res, () => { nexted = true; });
    return { status, body, nexted };
  };
  const base = { headers: { host: 'h' }, query: {} };

  assert.strictEqual(run({ ...base, headers: { host: 'h', 'x-lightshow-token': 'sesame' } }).nexted, true);
  assert.strictEqual(run({ ...base, query: { token: 'sesame' } }).nexted, true);
  assert.strictEqual(run({ ...base, headers: { host: 'h', 'x-lightshow-token': 'nope' } }).status, 401);
  assert.strictEqual(run(base).status, 401);

  // No token configured: requests pass, but the origin check still applies.
  const open = createAuth({ token: '' });
  let opened = false;
  open.httpMiddleware(base, {}, () => { opened = true; });
  assert.strictEqual(opened, true);
});

test('socket handshake requires the token', () => {
  const auth = createAuth({ token: 'sesame' });
  const attempt = (token) => new Promise((resolve) => {
    auth.socketMiddleware({ handshake: { auth: { token }, query: {} } }, (err) => resolve(!err));
  });
  return Promise.all([
    attempt('sesame').then((ok) => assert.strictEqual(ok, true)),
    attempt('nope').then((ok) => assert.strictEqual(ok, false)),
    attempt(undefined).then((ok) => assert.strictEqual(ok, false)),
  ]);
});
