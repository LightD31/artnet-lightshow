import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import pino from 'pino';
import type { Logger } from 'pino';

// Write crash logs synchronously so the last events survive process failure.

export type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVELS: Record<LevelName, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const NAMES = Object.fromEntries(Object.entries(LEVELS).map(([name, value]) => [value, name])) as Record<number, LevelName>;

export interface LogEntry {
  seq: number;
  time: number;
  level: LevelName;
  component: string | null;
  msg: string;
  data?: Record<string, unknown>;
  previous?: true;
}

type NewEntry = Omit<LogEntry, 'seq'>;

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

  get last(): number {
    return this._seq;
  }

  since(after = 0, { level = 'trace', limit = 500 }: { level?: LevelName; limit?: number } = {}): LogEntry[] {
    const min = LEVELS[level] ?? 0;
    const out = this._entries.filter((e) => e.seq > after && LEVELS[e.level] >= min);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }
}

export function splitComponent(text: string): { component: string | null; msg: string } {
  const m = /^(\s*)\[([^\]\n]{1,40})\] ?([\s\S]*)$/.exec(text);
  return m ? { component: m[2], msg: m[1] + m[3] } : { component: null, msg: text };
}

const SKIP = new Set(['level', 'time', 'msg', 'component', 'pid', 'hostname']);

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

export function prettyLine(entry: NewEntry, { colour = false }: { colour?: boolean } = {}): string {
  const paint = (code: string | undefined, text: string) => (colour && code ? `\u001b[${code}m${text}\u001b[0m` : text);
  const t = new Date(entry.time);
  const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const level = entry.level === 'info' ? '' : `${paint(COLOURS[entry.level], entry.level.toUpperCase())} `;
  const component = entry.component ? `[${entry.component}] ` : '';
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const lead = /^\n*/.exec(entry.msg)?.[0] || '';
  return `${lead}${paint('2', time)} ${level}${component}${entry.msg.slice(lead.length)}${data}\n`;
}

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
      // Ignore disk-write failures so logging cannot stop the show.
    }
  }

  close(): void {
    if (this._fd === null) return;
    try { fs.closeSync(this._fd); } catch (_) { /* already closed */ }
    this._fd = null;
  }
}

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

export function logger(component: string): Logger {
  return root.child({ component });
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const CONSOLE_LEVELS: Record<ConsoleMethod, LevelName> = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

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

export function releaseConsole(): void {
  if (!original) return;
  for (const [method, fn] of Object.entries(original)) (console as unknown as Record<string, unknown>)[method] = fn;
  original = null;
}

export interface LoggingOptions {
  dir?: string | null;
  terminal?: 'pretty' | 'json' | 'auto' | 'none';
  console?: boolean;
}

let file: RotatingFile | null = null;

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
