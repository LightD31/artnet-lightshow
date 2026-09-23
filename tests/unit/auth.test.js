import test from 'node:test';
import assert from 'node:assert';
import { createAuth, configError, isLoopbackHost, originAllowed, safeEqual } from '../../src/server/auth.ts';
import os from 'node:os';
import { hostAllowed } from '../../src/server/auth.ts';

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

  const err = configError({ host: '0.0.0.0', token: '', configFile: '/etc/lightshow/settings.json' });
  assert.ok(err, 'must refuse');
  // Reaching this means the file was hand-edited: the settings page refuses to
  // save it. With the server down there is no UI to fix it from, so the message
  // has to name the file and both ways out.
  assert.match(err, /\/etc\/lightshow\/settings\.json/, 'names the file to edit');
  assert.match(err, /"host": "127\.0\.0\.1"/, 'offers the loopback fix');
  assert.match(err, /"token":/, 'offers the token fix');
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
    auth.socketMiddleware({ handshake: { auth: { token }, query: {} } }, (err) => resolve(err || null));
  });
  return Promise.all([
    attempt('sesame').then((err) => assert.strictEqual(err, null)),
    attempt('nope').then((err) => assert.ok(err)),
    attempt(undefined).then((err) => assert.ok(err)),
  ]);
});

// Socket.IO never retries a handshake a middleware rejected, so this error is
// the operator's only clue. It has to say which of the two it is, and carry a
// code the client can key off without matching on wording.
test('a refused handshake says why, and says it in a way the client can read', async () => {
  const auth = createAuth({ token: 'sesame' });
  const refuse = (handshake) => new Promise((resolve) => {
    auth.socketMiddleware({ handshake }, resolve);
  });

  const missing = await refuse({ auth: {}, query: {} });
  assert.match(missing.message, /requires an access token/i);
  assert.deepStrictEqual(missing.data, { code: 'unauthorized', presented: false });

  const wrong = await refuse({ auth: { token: 'nope' }, query: {} });
  assert.match(wrong.message, /refused/i);
  assert.deepStrictEqual(wrong.data, { code: 'unauthorized', presented: true });

  // Never echo the configured token back to whoever guessed at it.
  assert.ok(!missing.message.includes('sesame') && !wrong.message.includes('sesame'));
});

// DNS rebinding: a page re-points its own domain at 127.0.0.1, so its requests
// arrive with Origin and Host that agree. Only the host name gives it away.
test('host check refuses names this machine is not known by', () => {
  const own = os.hostname().toLowerCase();

  for (const host of ['127.0.0.1:3000', '192.168.1.20:3000', '[::1]:3000', 'localhost:3000',
    'LOCALHOST', 'app.localhost:3000', `${own}:3000`, `${own.split('.')[0]}.local:3000`, undefined, '']) {
    assert.strictEqual(hostAllowed(host), true, String(host));
  }
  for (const host of ['attacker.example:3000', 'attacker.example', 'localhost.attacker.example',
    `${own}.attacker.example:3000`, '[garbage']) {
    assert.strictEqual(hostAllowed(host), false, host);
  }
  // Configured names — the bind host and the public URL — are accepted.
  assert.strictEqual(hostAllowed('lights.lan:3000', ['lights.lan:8443']), true);
  assert.strictEqual(hostAllowed('lights.lan', ['other.lan']), false);
});

test('host middleware answers 403 before anything else runs', () => {
  const auth = createAuth({ token: '', allowedHosts: () => ['lights.lan'] });
  const run = (host) => {
    let status = null; let nexted = false;
    const res = {
      status(c) { status = c; return this; },
      type() { return this; },
      send() { return this; },
    };
    auth.hostMiddleware({ headers: { host } }, res, () => { nexted = true; });
    return { status, nexted };
  };
  assert.deepStrictEqual(run('localhost:3000'), { status: null, nexted: true });
  assert.deepStrictEqual(run('lights.lan'), { status: null, nexted: true });
  assert.deepStrictEqual(run('rebind.example:3000'), { status: 403, nexted: false });
});

// Browsers do not apply CORS to WebSockets, so the socket handshake has to
// check the Origin itself — with or without a token configured.
test('socket handshake refuses other origins and unknown hosts, token or not', async () => {
  for (const token of ['', 'sesame']) {
    const auth = createAuth({ token });
    const allow = (headers) => new Promise((resolve) => {
      auth.allowSocketRequest({ headers }, (err, ok) => resolve({ err, ok }));
    });
    assert.strictEqual((await allow({ host: 'localhost:3000' })).ok, true, 'no Origin (Companion)');
    assert.strictEqual((await allow({ host: 'localhost:3000', origin: 'http://localhost:3000' })).ok, true);
    assert.strictEqual((await allow({ host: 'localhost:3000', origin: 'https://evil.example' })).ok, false);
    assert.strictEqual((await allow({ host: 'evil.example:3000', origin: 'http://evil.example:3000' })).ok, false);
  }
});
