import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import pino from 'pino';
import type { Logger } from 'pino';

/**
 * The server's log: structured (pino), kept three ways.
 *
 *   the terminal    a readable line per entry on a terminal, the JSON record
 *                   otherwise (a service manager, a pipe) — LOG_FORMAT
 *                   overrides;
 *   a file          logs/lightshow.log, JSON lines, rotated at 10 MB with
 *                   three old files kept. Written synchronously: the lines
 *                   before a crash are the ones worth having;
 *   memory          the last thousand entries, for the log view and
 *                   GET /api/logs — with the tail of the run before this one,
 *                   read back from the file at startup, so after a crash the
 *                   log view still shows what led up to it.
 *
 * Every module already signs what it prints — `console.warn('[show] …')` — so
 * rather than rewrite a hundred and eighty calls, startLogging() takes the
 * console over: each call becomes an entry at its level, the bracketed tag its
 * component. What the libraries print arrives the same way. New code can ask
 * for logger('component') and add fields of its own.
 */

export type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVELS: Record<LevelName, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const NAMES = Object.fromEntries(Object.entries(LEVELS).map(([name, value]) => [value, name])) as Record<number, LevelName>;

export interface LogEntry {
  /** Counts up within this run; what a reader asks for more after. */
  seq: number;
  /** Epoch milliseconds. */
  time: number;
  level: LevelName;
  /** What logged it — 'show', 'hue', 'supervisor'… — or null. */
  component: string | null;
  msg: string;
  /** Any other fields the record carried. */
  data?: Record<string, unknown>;
  /** From the run before this one, read back from the log file. */
  previous?: true;
}

type NewEntry = Omit<LogEntry, 'seq'>;

/** The last entries, oldest first. */
export class LogBuffer {
  declare _entries: LogEntry[];
  declare _max: number;
  declare _seq: number;

  constructor(max = 1000) {
    this._entries = [];
    this._max = max;
    this._seq = 0;
  }

  push(entry: NewEntry): LogEntry {
    const stored = { ...entry, seq: ++this._seq };
    this._entries.push(stored);
    if (this._entries.length > this._max) this._entries.splice(0, this._entries.length - this._max);
    return stored;
  }

  /** The last entry's seq: what to ask for more after. */
  get last(): number {
    return this._seq;
  }

  /**
   * Entries after `after` at `level` or above, the latest `limit` of them.
   * A reader that polls passes the `last` it was given back as `after`.
   */
  since(after = 0, { level = 'trace', limit = 500 }: { level?: LevelName; limit?: number } = {}): LogEntry[] {
    const min = LEVELS[level] ?? 0;
    const out = this._entries.filter((e) => e.seq > after && LEVELS[e.level] >= min);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }
}

/** "[component] message", the way the server's messages are signed, apart. */
export function splitComponent(text: string): { component: string | null; msg: string } {
  const m = /^(\s*)\[([^\]\n]{1,40})\] ?([\s\S]*)$/.exec(text);
  return m ? { component: m[2], msg: m[1] + m[3] } : { component: null, msg: text };
}

const SKIP = new Set(['level', 'time', 'msg', 'component', 'pid', 'hostname']);

/** A pino record as an entry; null for what is not one. */
export function entryOf(record: unknown): NewEntry | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const level = NAMES[Number(r.level)];
  if (!level) return null;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!SKIP.has(k)) data[k] = v;
  return {
    time: Number(r.time) || Date.now(),
    level,
    component: typeof r.component === 'string' ? r.component : null,
    msg: typeof r.msg === 'string' ? r.msg : '',
    ...(Object.keys(data).length ? { data } : {}),
  };
}

const COLOURS: Partial<Record<LevelName, string>> = { trace: '2', debug: '2', warn: '33', error: '31', fatal: '1;31' };

/** An entry as a line for a person at a terminal. Info, the usual, carries no level. */
export function prettyLine(entry: NewEntry, { colour = false }: { colour?: boolean } = {}): string {
  const paint = (code: string | undefined, text: string) => (colour && code ? `\u001b[${code}m${text}\u001b[0m` : text);
  const t = new Date(entry.time);
  const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const level = entry.level === 'info' ? '' : `${paint(COLOURS[entry.level], entry.level.toUpperCase())} `;
  const component = entry.component ? `[${entry.component}] ` : '';
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  // A message that opens with a blank line (the startup banner) keeps it,
  // before the time rather than after.
  const lead = /^\n*/.exec(entry.msg)?.[0] || '';
  return `${lead}${paint('2', time)} ${level}${component}${entry.msg.slice(lead.length)}${data}\n`;
}

/**
 * A log file that rotates: past `maxBytes`, lightshow.log becomes
 * lightshow.1.log (and .1 becomes .2, and so on to `keep`), and a new one is
 * started. Written synchronously, so nothing is lost to a crash but the line
 * being written.
 */
export class RotatingFile {
  declare file: string;
  declare _maxBytes: number;
  declare _keep: number;
  declare _fd: number | null;
  declare _size: number;

  constructor(file: string, { maxBytes = 10 * 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {}) {
    this.file = file;
    this._maxBytes = maxBytes;
    this._keep = keep;
    this._fd = null;
    this._size = 0;
  }

  _open(): number {
    if (this._fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._fd = fs.openSync(this.file, 'a');
      this._size = fs.fstatSync(this._fd).size;
    }
    return this._fd;
  }

  _rotate(): void {
    this.close();
    const aged = (n: number) => this.file.replace(/(\.log)?$/, `.${n}$1`);
    try { fs.rmSync(aged(this._keep), { force: true }); } catch (_) { /* nothing to drop */ }
    for (let n = this._keep - 1; n >= 1; n--) {
      try { fs.renameSync(aged(n), aged(n + 1)); } catch (_) { /* not that many yet */ }
    }
    try { fs.renameSync(this.file, aged(1)); } catch (_) { /* gone already */ }
  }

  write(line: string): void {
    try {
      const bytes = Buffer.byteLength(line);
      this._open();
      if (this._size > 0 && this._size + bytes > this._maxBytes) this._rotate();
      fs.writeSync(this._open(), line);
      this._size += bytes;
    } catch (_) {
      // A full disk must not take the show down with it; the terminal and the
      // log view still have the entry.
    }
  }

  close(): void {
    if (this._fd === null) return;
    try { fs.closeSync(this._fd); } catch (_) { /* already closed */ }
    this._fd = null;
  }
}

/**
 * The last entries of a log file — the run before this one — at most
 * `maxLines`, read from its last 256 KB.
 */
export function readTail(file: string, maxLines = 200): NewEntry[] {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);   // a partial first line
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
  const out: NewEntry[] = [];
  for (const line of text.split('\n').slice(-maxLines - 1)) {
    if (!line.trim()) continue;
    try {
      const entry = entryOf(JSON.parse(line));
      if (entry) out.push(entry);
    } catch (_) { /* not ours */ }
  }
  return out.slice(-maxLines);
}

// ── The server's log ─────────────────────────────────────────────────────────

/** What the log view reads. */
export const buffer = new LogBuffer(1000);

const streams = pino.multistream([{
  level: 'trace',
  stream: {
    write(line: string) {
      try {
        const entry = entryOf(JSON.parse(line));
        if (entry) buffer.push(entry);
      } catch (_) { /* a line pino wrote is always JSON */ }
    },
  },
}]);

const root: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  messageKey: 'msg',
  timestamp: pino.stdTimeFunctions.epochTime,
}, streams);

/** A logger for one part of the server; its entries carry `component`. */
export function logger(component: string): Logger {
  return root.child({ component });
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const CONSOLE_LEVELS: Record<ConsoleMethod, LevelName> = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

/** Every console call from here on as an entry: its level, and its tag as the component. */
function captureConsole(): void {
  if (original) return;
  original = {};
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    original[method] = console[method];
    const level = CONSOLE_LEVELS[method];
    console[method] = (...args: unknown[]) => {
      const { component, msg } = splitComponent(format(...args));
      root[level](component ? { component } : {}, msg);
    };
  }
}

/** Give the console back (for tests). */
export function releaseConsole(): void {
  if (!original) return;
  for (const [method, fn] of Object.entries(original)) (console as unknown as Record<string, unknown>)[method] = fn;
  original = null;
}

export interface LoggingOptions {
  /** The log file's directory; none, no file. */
  dir?: string | null;
  /** 'pretty', 'json', or 'auto' (pretty on a terminal); LOG_FORMAT overrides. */
  terminal?: 'pretty' | 'json' | 'auto' | 'none';
  /** Take the console over (the server does; a test need not). */
  console?: boolean;
}

let file: RotatingFile | null = null;

/**
 * Start logging to the terminal and the file, reading back the tail of the
 * last run first. Called once, first thing, by the server.
 */
export function startLogging({ dir = null, terminal = 'auto', console: capture = true }: LoggingOptions = {}): { file: string | null } {
  if (dir) {
    const logFile = path.join(dir, 'lightshow.log');
    for (const entry of readTail(logFile)) buffer.push({ ...entry, previous: true });
    file = new RotatingFile(logFile);
    const f = file;
    streams.add({ level: 'trace', stream: { write: (line: string) => f.write(line) } });
  }

  const mode = (process.env.LOG_FORMAT as LoggingOptions['terminal']) || terminal;
  const pretty = mode === 'pretty' || (mode === 'auto' && !!process.stdout.isTTY);
  if (mode !== 'none') {
    const colour = pretty && !!process.stdout.isTTY && !process.env.NO_COLOR;
    streams.add({
      level: 'trace',
      stream: {
        write(line: string) {
          let entry: NewEntry | null = null;
          try { entry = entryOf(JSON.parse(line)); } catch (_) { /* written as it came */ }
          const out = entry && LEVELS[entry.level] >= LEVELS.warn ? process.stderr : process.stdout;
          out.write(pretty && entry ? prettyLine(entry, { colour }) : line);
        },
      },
    });
  }

  if (capture) captureConsole();
  return { file: file ? file.file : null };
}
