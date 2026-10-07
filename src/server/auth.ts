import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Socket } from 'socket.io';
import { isLoopback } from './loopback.ts';

type AllowCallback = (err: string | null | undefined, success: boolean) => void;

export interface Auth {
  enabled: boolean;
  hostMiddleware(req: Request, res: Response, next: NextFunction): void;
  allowSocketRequest(req: IncomingMessage, callback: AllowCallback): void;
  httpMiddleware(req: Request, res: Response, next: NextFunction): void;
  socketMiddleware(socket: Socket, next: (err?: Error) => void): void;
}

// Check token, Origin and Host independently; localhost still needs CSRF and rebinding protection.

function safeEqual(a: unknown, b: unknown): boolean {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function configError({ host, token, configFile = 'config/settings.json' }: {
  host: string;
  token: string;
  configFile?: string;
}): string | null {
  if (isLoopback(host) || token) return null;
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
    'both settings are editable in the app under Settings → Server & access.',
  ].join('\n');
}

// Allow clients without Origin while checking browser-supplied origins for cross-site requests.
function originAllowed(req: { headers: IncomingHttpHeaders }): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;                       // not a browser-initiated cross-origin request

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

function hostnameOf(hostHeader: unknown): string {
  let raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  const colon = raw.indexOf(':');
  if (colon >= 0 && colon === raw.lastIndexOf(':')) raw = raw.slice(0, colon);
  return raw.endsWith('.') ? raw.slice(0, -1) : raw;
}

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

// Validate Host as well as Origin because DNS rebinding can make both attacker-controlled values agree.
function hostAllowed(hostHeader: unknown, extraNames: readonly string[] = []): boolean {
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return true;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (machineNames().has(name)) return true;
  return extraNames.some((extra) => hostnameOf(extra) === name);
}

function hostOfUrl(value: string | null | undefined): string {
  if (!value) return '';
  try { return new URL(value).host; } catch (_) { return ''; }
}

function tokenFromRequest(req: Request): unknown {
  return req.headers['x-lightshow-token']
    || (req.query && req.query.token)
    || '';
}

// Log each refused host only once so browser retries do not flood the console.
const warnedHosts = new Set();

function warnRefusedHost(name: string): void {
  if (warnedHosts.has(name) || warnedHosts.size > 32) return;
  warnedHosts.add(name);
  console.warn(`[auth] refused a request for host "${name}". If that is how you reach this machine, `
    + 'set it as the Public URL in Settings → Server & Access.');
}

function createAuth({ token = '', allowedHosts = () => [] }: {
  token?: string;
  allowedHosts?: () => string[];
} = {}): Auth {
  const enabled = !!token;

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

  // Apply host and origin checks to Socket.IO separately because its handshake bypasses Express.
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
    const presented = socket.handshake.headers?.['x-lightshow-token']
      || (socket.handshake.auth && socket.handshake.auth.token)
      || socket.handshake.query.token
      || '';
    if (safeEqual(presented, token)) return next();

    const err: Error & { data?: unknown } = new Error(presented
      ? 'Access token refused'
      : 'This server requires an access token');
    err.data = { code: 'unauthorized', presented: !!presented };
    next(err);
  }

  return { enabled, hostMiddleware, allowSocketRequest, httpMiddleware, socketMiddleware };
}

function sourceMapsForLoopback(req: { path: string; socket: { remoteAddress?: string } },
  res: { status(code: number): { end(): void } }, next: () => void): void {
  if (req.path.endsWith('.map') && !isLoopback(req.socket.remoteAddress)) {
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
  sourceMapsForLoopback,
  originAllowed,
  safeEqual,
};
