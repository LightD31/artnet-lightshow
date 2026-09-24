import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Socket } from 'socket.io';

/** Socket.IO's answer to a handshake: an error, or whether to let it in. */
type AllowCallback = (err: string | null | undefined, success: boolean) => void;

/** The access checks, for Express and for Socket.IO. */
export interface Auth {
  enabled: boolean;
  hostMiddleware(req: Request, res: Response, next: NextFunction): void;
  allowSocketRequest(req: IncomingMessage, callback: AllowCallback): void;
  httpMiddleware(req: Request, res: Response, next: NextFunction): void;
  socketMiddleware(socket: Socket, next: (err?: Error) => void): void;
}

/**
 * Access control for the control surface.
 *
 * Two independent concerns, deliberately kept separate:
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
 *      check below rejects those regardless of whether a token is configured,
 *      and the host check rejects a page that re-points its own domain at this
 *      machine (DNS rebinding), which the origin check alone cannot see.
 *
 * This is proportionate defence for a tool on a venue network. It is not a
 * hardened auth system: one shared secret, no users, no revocation.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/** True when `host` only accepts connections from this machine. */
function isLoopbackHost(host: unknown): boolean {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: unknown, b: unknown): boolean {
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
function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Refuse to start in a configuration that silently exposes the rig.
 * Returns a fatal message, or null when the configuration is acceptable.
 */
function configError({ host, token, configFile = 'config/settings.json' }: {
  host: string;
  token: string;
  configFile?: string;
}): string | null {
  if (isLoopbackHost(host) || token) return null;
  // The settings page normally refuses to save this combination, so reaching
  // here means the file was hand-edited — and with the server refusing to
  // start there is no UI to fix it from. Give file-level instructions.
  return [
    `Refusing to start: the bind address is "${host}" (not loopback) with no access token.`,
    '',
    'That would expose blackout, strobe and Art-Net control to every device on',
    'the network with no authentication at all.',
    '',
    `Edit ${configFile} and either:`,
    '  • set  "host": "127.0.0.1"   (this machine only), or',
    `  • set  "token": "${generateToken()}"`,
    '',
    'With a token set, open the UI once at:',
    '  http://<this-machine>:<port>/?token=<the token>',
    'The page stores it and sends it on every request afterwards. After that,',
    'both settings are editable in the settings page under Server & Access.',
  ].join('\n');
}

/**
 * Is this request's Origin allowed to drive the API?
 *
 * Browsers set Origin themselves and a page cannot forge it, so this is a
 * reliable filter for cross-site requests. Non-browser clients (Companion,
 * curl, scripts) send no Origin and are unaffected.
 */
function originAllowed(req: { headers: IncomingHttpHeaders }): boolean {
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

/**
 * The host name a `Host` header names, lower-cased, without port or brackets.
 * Empty when there is nothing usable in it.
 */
function hostnameOf(hostHeader: unknown): string {
  let raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  // One colon is a port; several are an unbracketed IPv6 literal.
  const colon = raw.indexOf(':');
  if (colon >= 0 && colon === raw.lastIndexOf(':')) raw = raw.slice(0, colon);
  return raw.endsWith('.') ? raw.slice(0, -1) : raw;
}

/** The names this machine answers to on a LAN without any configuration. */
function machineNames(): Set<string> {
  const names = new Set<string>();
  const full = String(os.hostname() || '').trim().toLowerCase();
  if (!full) return names;
  const short = full.split('.')[0];
  for (const name of [full, short]) {
    names.add(name);
    names.add(`${name}.local`);
  }
  return names;
}

/**
 * May a request carrying this `Host` header reach the server?
 *
 * The origin check alone cannot stop DNS rebinding: a page on
 * attacker.example re-resolves its own name to 127.0.0.1, and from then on its
 * requests carry `Origin: http://attacker.example:3000` *and*
 * `Host: attacker.example:3000`, so origin and host agree and the request
 * looks same-origin. What it cannot fake is a host name this machine is
 * actually known by, so the Host header is checked against those:
 *
 *   - any IP literal — rebinding needs a name, and an address typed into the
 *     address bar is the normal way to reach the rig from a phone;
 *   - localhost and *.localhost, which browsers never resolve through DNS;
 *   - this machine's own host name, bare and with `.local`;
 *   - whatever the operator configured: the bind host and the public URL.
 *
 * A request with no Host header at all is not a browser (HTTP/1.1 browsers
 * always send one), so it is left to the token check.
 */
function hostAllowed(hostHeader: unknown, extraNames: readonly string[] = []): boolean {
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return true;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (machineNames().has(name)) return true;
  return extraNames.some((extra) => hostnameOf(extra) === name);
}

/** The host name of a configured URL such as `server.publicUrl`, or ''. */
function hostOfUrl(value: string | null | undefined): string {
  if (!value) return '';
  try { return new URL(value).host; } catch (_) { return ''; }
}

/** Pull a presented token out of an Express request. */
function tokenFromRequest(req: Request): unknown {
  return req.headers['x-lightshow-token']
    || (req.query && req.query.token)
    || '';
}

// A refused Host is almost always an operator reaching the rig by a name the
// server does not know, so it is worth one console line — but only one per
// name, since a browser retries.
const warnedHosts = new Set();

function warnRefusedHost(name: string): void {
  if (warnedHosts.has(name) || warnedHosts.size > 32) return;
  warnedHosts.add(name);
  console.warn(`[auth] refused a request for host "${name}". If that is how you reach this machine, `
    + 'set it as the Public URL in Settings → Server & Access.');
}

/**
 * Build the Express middleware and the Socket.IO handshake guard.
 *
 * `token` empty means authentication is disabled — only valid on a loopback
 * bind, which configError() enforces at startup. The origin and host checks
 * still run.
 *
 * `allowedHosts` returns extra host names to accept (the configured bind host
 * and public URL). It is a function so a public URL changed in the settings
 * page applies without a restart.
 */
function createAuth({ token = '', allowedHosts = () => [] }: {
  token?: string;
  allowedHosts?: () => string[];
} = {}): Auth {
  const enabled = !!token;

  /** Refuse requests addressed to a host name this machine is not known by. */
  function hostMiddleware(req: Request, res: Response, next: NextFunction) {
    if (hostAllowed(req.headers.host, allowedHosts())) return next();
    const name = hostnameOf(req.headers.host);
    warnRefusedHost(name);
    return res.status(403).type('text/plain').send(
      `Host "${name}" is not one this server answers to. Open it by IP address, `
      + 'by localhost, or by this machine\'s name, or set that name as the Public URL '
      + 'in Settings → Server & Access.',
    );
  }

  /**
   * Socket.IO `allowRequest`: the handshake is an HTTP request that never
   * passes through Express, so it gets the host and origin checks here.
   *
   * The origin check matters most on this path. Browsers do not apply CORS to
   * WebSockets, so without it any page the operator has open could connect to
   * ws://127.0.0.1 and send `set` — blackout, strobe, the Art-Net target —
   * whether or not a token is configured.
   */
  function allowSocketRequest(req: IncomingMessage, callback: AllowCallback) {
    if (!hostAllowed(req.headers.host, allowedHosts())) {
      warnRefusedHost(hostnameOf(req.headers.host));
      return callback('Host not allowed', false);
    }
    if (!originAllowed(req)) return callback('Cross-origin connection refused', false);
    return callback(null, true);
  }

  function httpMiddleware(req: Request, res: Response, next: NextFunction) {
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

  function socketMiddleware(socket: Socket, next: (err?: Error) => void) {
    if (!enabled) return next();
    const presented = (socket.handshake.auth && socket.handshake.auth.token)
      || socket.handshake.query.token
      || '';
    if (safeEqual(presented, token)) return next();

    // Socket.IO does not retry a handshake a middleware rejected, so this
    // message is the only thing the operator gets — "unauthorized" left them
    // staring at a page that claimed it was reconnecting. Say which of the two
    // it is, and carry a code so the client does not have to match on wording.
    const err: Error & { data?: unknown } = new Error(presented
      ? 'Access token refused'
      : 'This server requires an access token');
    err.data = { code: 'unauthorized', presented: !!presented };
    next(err);
  }

  return { enabled, hostMiddleware, allowSocketRequest, httpMiddleware, socketMiddleware };
}

/**
 * Source maps only to this machine. The bundle's map is the client's whole
 * source, 700 KB of it, and the one person who needs it is debugging at the
 * machine running the show; every phone on the venue network does not.
 */
function sourceMapsForLoopback(req: { path: string; socket: { remoteAddress?: string } },
  res: { status(code: number): { end(): void } }, next: () => void): void {
  if (req.path.endsWith('.map') && !isLoopbackHost(req.socket.remoteAddress)) {
    res.status(404).end();
    return;
  }
  next();
}

export {
  createAuth,
  configError,
  generateToken,
  hostAllowed,
  hostnameOf,
  hostOfUrl,
  isLoopbackHost,
  sourceMapsForLoopback,
  originAllowed,
  safeEqual,
};
