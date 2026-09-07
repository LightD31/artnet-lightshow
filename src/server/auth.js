'use strict';

const crypto = require('crypto');

/**
 * Access control for the control surface.
 *
 * Two independent concerns, deliberately kept separate — see AUDIT.md C2:
 *
 *   1. Authentication (who may talk to the API at all). A shared token,
 *      required whenever the server is bound to anything other than loopback.
 *      Sent as an `X-Lightshow-Token` header, a `token` query parameter, or a
 *      Socket.IO handshake `auth.token`.
 *
 *   2. CSRF (which *pages* may talk to it). Even on a loopback bind with no
 *      token, a website the operator has open in another tab can POST to
 *      localhost — several control routes take no body, which makes them
 *      "simple" cross-origin requests that skip preflight entirely. The origin
 *      check below rejects those regardless of whether a token is configured.
 *
 * This is proportionate defence for a tool on a venue network. It is not a
 * hardened auth system: one shared secret, no users, no revocation.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/** True when `host` only accepts connections from this machine. */
function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length isn't leaked by timing alone.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Generate a token suitable for LIGHTSHOW_TOKEN. */
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Refuse to start in a configuration that silently exposes the rig.
 * Returns a fatal message, or null when the configuration is acceptable.
 */
function configError({ host, token }) {
  if (isLoopbackHost(host) || token) return null;
  return [
    `Refusing to start: HOST is "${host}" (not loopback) with no LIGHTSHOW_TOKEN set.`,
    '',
    'That would expose blackout, strobe and Art-Net control to every device on',
    'the network with no authentication at all.',
    '',
    'Either:',
    '  • drop HOST (defaults to 127.0.0.1, this machine only), or',
    `  • set a token:  LIGHTSHOW_TOKEN=${generateToken()}`,
    '',
    'With a token set, open the UI once at:',
    '  http://<this-machine>:<port>/?token=<the token>',
    'The page stores it and sends it on every request afterwards.',
  ].join('\n');
}

/**
 * Is this request's Origin allowed to drive the API?
 *
 * Browsers set Origin themselves and a page cannot forge it, so this is a
 * reliable filter for cross-site requests. Non-browser clients (Companion,
 * curl, scripts) send no Origin and are unaffected.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // not a browser-initiated cross-origin request

  // The browser extension's background script legitimately posts now-playing
  // state from its own origin.
  if (/^(moz|chrome)-extension:\/\//.test(origin)) return true;

  try {
    const url = new URL(origin);
    const host = req.headers.host;
    if (!host) return false;
    return url.host === host;                     // same-origin (host includes the port)
  } catch (_) {
    return false;
  }
}

/** Pull a presented token out of an Express request. */
function tokenFromRequest(req) {
  return req.headers['x-lightshow-token']
    || (req.query && req.query.token)
    || '';
}

/**
 * Build the Express middleware and the Socket.IO handshake guard.
 *
 * `token` empty means authentication is disabled — only valid on a loopback
 * bind, which configError() enforces at startup. The origin check still runs.
 */
function createAuth({ token = '' } = {}) {
  const enabled = !!token;

  function httpMiddleware(req, res, next) {
    if (!originAllowed(req)) {
      return res.status(403).json({ ok: false, error: 'Cross-origin request refused' });
    }
    if (!enabled) return next();
    if (safeEqual(tokenFromRequest(req), token)) return next();
    return res.status(401).json({
      ok: false,
      error: 'Missing or invalid token. Open the UI with ?token=… or send an X-Lightshow-Token header.',
    });
  }

  function socketMiddleware(socket, next) {
    if (!enabled) return next();
    const presented = (socket.handshake.auth && socket.handshake.auth.token)
      || socket.handshake.query.token
      || '';
    if (safeEqual(presented, token)) return next();
    next(new Error('unauthorized'));
  }

  return { enabled, httpMiddleware, socketMiddleware };
}

module.exports = {
  createAuth,
  configError,
  generateToken,
  isLoopbackHost,
  originAllowed,
  safeEqual,
};
