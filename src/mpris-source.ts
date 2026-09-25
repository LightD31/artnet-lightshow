/**
 * Linux "now playing" reader (MPRIS, over D-Bus).
 *
 * The Linux counterpart of smtc-source.ts. Every Linux player worth the name —
 * Spotify, Firefox and Chromium tabs, VLC, mpv, Rhythmbox, Strawberry, Tidal
 * and Deezer desktop clients — publishes itself on the session bus as
 * `org.mpris.MediaPlayer2.<name>`, with the track, whether it is playing and
 * where it is. Reading that gets any of them driving the show, with no
 * per-service credentials, exactly as the Windows media session does.
 *
 * The bus is read through `busctl`, which comes with systemd and so is on
 * every mainstream desktop, asking for JSON: no D-Bus library to install, and
 * nothing native to build. Position is not something MPRIS announces as it
 * changes — it has to be asked for — so the reader polls, as the Windows one
 * does. The snapshots it hands on are the same shape as the Windows reader's,
 * so everything downstream is the same.
 */

import { spawn } from 'node:child_process';
import { codeOf, messageOf } from './errors.ts';
import type { NowPlaying } from './types/playback.ts';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';

// Players come and go far less often than the position moves: the list is
// asked for every few polls, the chosen players on every one.
const NAMES_EVERY_MS = 3000;
// A bus that is not there (no desktop session) or a busctl that is missing is
// not going to appear a second later.
const RETRY_MS = 15000;
const CALL_TIMEOUT_MS = 2000;

/** What a command answered: its exit code and what it printed. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs busctl with these arguments. Injectable, for tests. */
export type Busctl = (args: string[]) => Promise<CommandResult>;

/** One player's state, read off the bus. */
export interface PlayerState {
  name: string;
  status: 'Playing' | 'Paused' | 'Stopped' | string;
  title: string;
  artist: string;
  album: string;
  artUrl: string | null;
  lengthUs: number;
  positionUs: number;
}

/** A D-Bus value as busctl prints it in JSON. */
interface Variant {
  type: string;
  data: unknown;
}

function runBusctl(command: string): Busctl {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The value of a variant, or undefined. */
function valueOf(variant: unknown): unknown {
  return variant && typeof variant === 'object' && 'data' in variant ? (variant as Variant).data : undefined;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const microseconds = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * A player's state from busctl's answer to get-property PlaybackStatus
 * Metadata [Position]: one JSON value a line, in that order.
 */
function parsePlayer(name: string, stdout: string): PlayerState | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  let values: unknown[];
  try {
    values = lines.map((line) => JSON.parse(line));
  } catch (_) {
    return null;
  }
  if (values.length < 2) return null;
  const status = text(valueOf(values[0]));
  const meta = valueOf(values[1]);
  const field = (key: string) => (meta && typeof meta === 'object' ? valueOf((meta as Record<string, unknown>)[key]) : undefined);
  const artists = field('xesam:artist');
  const art = text(field('mpris:artUrl'));
  return {
    name,
    status,
    title: text(field('xesam:title')),
    // A list, by the spec; one player or another sends a plain string.
    artist: Array.isArray(artists) ? artists.filter((a) => typeof a === 'string').join(', ') : text(artists),
    album: text(field('xesam:album')),
    artUrl: /^https?:\/\//i.test(art) ? art : null,
    lengthUs: microseconds(field('mpris:length')),
    positionUs: values.length > 2 ? microseconds(valueOf(values[2])) : 0,
  };
}

/** "spotify", "firefox" — the bus name without its prefix or its instance. */
function appOf(name: string): string {
  return name.slice(PREFIX.length).replace(/\.instance_?\d+(_\d+)?$/, '');
}

class MprisReader {
  declare _busctl: Busctl;
  declare _intervalMs: number;
  declare _timer: ReturnType<typeof setTimeout> | null;
  declare _running: boolean;
  declare _names: string[];
  declare _namesAt: number;
  declare _noPosition: Set<string>;
  declare _started: Map<string, number>;
  declare _lastPlaying: Map<string, number>;
  declare _wasPlaying: Set<string>;
  declare _chosen: string | null;
  declare _onUpdate: ((playing: NowPlaying) => void) | null;
  declare _onIdle: (() => void) | null;
  declare _loggedError: string | null;
  declare _now: () => number;

  constructor({ busctl, intervalMs = 500, now = Date.now }: { busctl?: Busctl | string; intervalMs?: number; now?: () => number } = {}) {
    this._busctl = typeof busctl === 'function' ? busctl : runBusctl(busctl || 'busctl');
    this._intervalMs = intervalMs;
    this._timer = null;
    this._running = false;
    this._names = [];
    this._namesAt = -Infinity;
    // Players that answer an error for Position: asked without it after.
    this._noPosition = new Set();
    // When each player started playing, and was last seen playing: the one
    // started most recently is followed, and with none playing, the one that
    // played last.
    this._started = new Map();
    this._lastPlaying = new Map();
    this._wasPlaying = new Set();
    this._chosen = null;
    this._onUpdate = null;
    this._onIdle = null;
    this._loggedError = null;
    this._now = now;
  }

  /** Called with a normalized playback snapshot on every poll with a track. */
  onUpdate(fn: ((playing: NowPlaying) => void) | null): void { this._onUpdate = fn; }
  /** Called when no player has a track. */
  onIdle(fn: (() => void) | null): void { this._onIdle = fn; }

  /** Start polling. False where there is no D-Bus session to read (Windows, macOS). */
  start(): boolean {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      console.warn('[mpris] not on Linux — now-playing source disabled');
      return false;
    }
    if (this._running) return true;
    this._running = true;
    console.log('[mpris] now-playing reader started');
    this._schedule(0);
    return true;
  }

  stop(): void {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule(ms: number): void {
    if (!this._running) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.poll().then((wait) => this._schedule(wait), (err) => {
        this._report(`reading the session bus failed: ${messageOf(err)}`);
        this._schedule(RETRY_MS);
      });
    }, ms);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** Say something went wrong, once until it changes or recovers. */
  _report(message: string): void {
    if (this._loggedError === message) return;
    this._loggedError = message;
    console.warn(`[mpris] ${message}`);
  }

  /**
   * One look at the bus: the players on it, each one's state, and the one
   * that is playing handed on. Resolves to how long to wait before the next.
   */
  async poll(): Promise<number> {
    const now = this._now();
    if (now - this._namesAt >= NAMES_EVERY_MS) {
      let listed: CommandResult;
      try {
        listed = await this._busctl(['--user', '--json=short', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
          'org.freedesktop.DBus', 'ListNames']);
      } catch (err) {
        this._report(codeOf(err) === 'ENOENT'
          ? 'busctl was not found; it comes with systemd — install it to follow what plays on this computer'
          : `could not run busctl: ${messageOf(err)}`);
        return RETRY_MS;
      }
      if (listed.code !== 0) {
        this._report(`no session bus to read (${listed.stderr.trim().split('\n')[0] || `exit ${listed.code}`}) — `
          + 'the server has to run inside the desktop session to see its players');
        return RETRY_MS;
      }
      try {
        const names = valueOf(JSON.parse(listed.stdout));
        const list = Array.isArray(names) && Array.isArray(names[0]) ? names[0] : [];
        this._names = list.filter((n): n is string => typeof n === 'string' && n.startsWith(PREFIX)).sort();
      } catch (_) {
        this._names = [];
      }
      this._namesAt = now;
    }

    const players: PlayerState[] = [];
    for (const name of this._names) {
      const player = await this._read(name);
      if (player) players.push(player);
    }
    this._loggedError = null;

    const pick = this.choose(players);
    if (!pick) {
      if (this._onIdle) this._onIdle();
    } else if (this._onUpdate) {
      this._onUpdate(this.toPayload(pick));
    }
    return this._intervalMs;
  }

  async _read(name: string): Promise<PlayerState | null> {
    const properties = this._noPosition.has(name) ? ['PlaybackStatus', 'Metadata'] : ['PlaybackStatus', 'Metadata', 'Position'];
    let result: CommandResult;
    try {
      result = await this._busctl(['--user', '--json=short', 'get-property', name, OBJECT, PLAYER, ...properties]);
    } catch (_) {
      return null;
    }
    if (result.code !== 0) {
      // A player that does not do Position says so for the whole call.
      if (properties.length === 3 && /Position/i.test(result.stderr)) {
        this._noPosition.add(name);
        return this._read(name);
      }
      return null;
    }
    return parsePlayer(name, result.stdout);
  }

  /**
   * The player to follow: one that is playing — the same one as last time if
   * it still is, else the one that started playing most recently — or, with
   * none playing, the one that played last, paused. Null with no track at all.
   */
  choose(players: PlayerState[]): PlayerState | null {
    const now = this._now();
    const withTrack = players.filter((p) => p.title);
    const playing = withTrack.filter((p) => p.status === 'Playing');
    for (const p of playing) {
      if (!this._wasPlaying.has(p.name)) this._started.set(p.name, now);
      this._lastPlaying.set(p.name, now);
    }
    this._wasPlaying = new Set(playing.map((p) => p.name));
    for (const map of [this._started, this._lastPlaying]) {
      for (const name of [...map.keys()]) if (!players.some((p) => p.name === name)) map.delete(name);
    }
    const latest = (times: Map<string, number>) => (a: PlayerState, b: PlayerState) => (times.get(b.name) ?? -1) - (times.get(a.name) ?? -1);
    let pick: PlayerState | null = playing.find((p) => p.name === this._chosen) || playing.sort(latest(this._started))[0] || null;
    if (!pick) {
      const paused = withTrack.filter((p) => p.status === 'Paused').sort(latest(this._lastPlaying));
      pick = paused.find((p) => p.name === this._chosen) || paused[0] || null;
    }
    this._chosen = pick ? pick.name : null;
    return pick;
  }

  /** A player's state as NowPlayingSource.updatePlayback() takes it. */
  toPayload(player: PlayerState): NowPlaying {
    return {
      // No ISRC on the bus, and a player's own track id is often a playlist
      // position: artist and title are the identity, as on Windows.
      trackId: `mpris:${player.artist.toLowerCase()}|${player.title.toLowerCase()}`,
      name: player.title,
      artist: player.artist,
      album: player.album,
      albumArt: player.artUrl,
      durationMs: Math.round(player.lengthUs / 1000),
      progressMs: Math.round(player.positionUs / 1000),
      isPlaying: player.status === 'Playing',
      isrc: null,
      sourceApp: appOf(player.name),
    };
  }
}

export { parsePlayer, appOf };
export default MprisReader;
