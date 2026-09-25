import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { buffer } from './log.ts';
import { engineStatus } from './engine.ts';
import * as output from './output.ts';
import { state } from './state.ts';
import { supervision } from './supervised.ts';
import type { Supervision } from './supervised.ts';
import type { EngineStatus } from './engine.ts';

/**
 * How the server is doing, in one answer (GET /api/health): up how long,
 * whether the engine is rendering on time, whether the main thread is keeping
 * up, memory, the outputs, the auto show, the errors logged lately, and how
 * often the supervisor has had to bring it back — with what is wrong, if
 * anything, said in words.
 *
 * The status is `ok`, `degraded` (something to look at; the show is running)
 * or `failing` (the show is not: the engine is down).
 */

export type HealthStatus = 'ok' | 'degraded' | 'failing';

export interface Problem {
  level: 'info' | 'warn' | 'error';
  what: string;
}

export interface EventLoopDelay {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** What assess() judges; health() gathers it from the running server. */
export interface HealthInputs {
  engine: Partial<EngineStatus> & { running: boolean };
  eventLoop: EventLoopDelay | null;
  rssMb: number;
  errors: { count: number; last: { component: string | null; msg: string } | null };
  supervisor: Supervision;
  auto: { status: string; error: string | null } | null;
}

const WINDOW_MS = 30_000;
const RECENT_ERRORS_MS = 10 * 60_000;
const STALL_MS = 100;
const LATE_SHARE = 0.05;
const RSS_MB = 1536;

/** What is wrong, in words, and the status it adds up to. */
export function assess(inputs: HealthInputs): { status: HealthStatus; problems: Problem[] } {
  const problems: Problem[] = [];
  const { engine, eventLoop, errors, supervisor, auto } = inputs;

  if (!engine.running) problems.push({ level: 'error', what: 'The engine is not running: nothing is going out to the rig.' });
  if (engine.fellBack) problems.push({ level: 'warn', what: 'The engine could not run on its own thread and fell back to the main one.' });
  const frames = engine.frames || 0;
  if (frames > 0 && (engine.lateFrames || 0) / frames > LATE_SHARE) {
    problems.push({ level: 'warn', what: `${Math.round(((engine.lateFrames || 0) / frames) * 100)}% of recent frames went out late.` });
  }
  if (eventLoop && eventLoop.p99Ms > STALL_MS) {
    problems.push({ level: 'warn', what: `The main thread stalled for up to ${Math.round(eventLoop.maxMs)} ms: the page and controllers answer late.` });
  }
  if (inputs.rssMb > RSS_MB) problems.push({ level: 'warn', what: `The server is using ${Math.round(inputs.rssMb)} MB of memory.` });
  if (errors.count) {
    const last = errors.last ? ` The last: ${errors.last.component ? `[${errors.last.component}] ` : ''}${errors.last.msg.split('\n')[0].slice(0, 160)}` : '';
    problems.push({ level: 'warn', what: `${errors.count} error${errors.count === 1 ? '' : 's'} logged in the last ten minutes.${last}` });
  }
  if (auto && auto.status === 'error' && auto.error) problems.push({ level: 'warn', what: `The auto show: ${auto.error}` });
  if (supervisor.restarts > 0) {
    const why = supervisor.lastExit ? ` The last: ${supervisor.lastExit.reason}.` : '';
    problems.push({ level: 'info', what: `Restarted ${supervisor.restarts} time${supervisor.restarts === 1 ? '' : 's'} by the supervisor.${why}` });
  }

  const status: HealthStatus = problems.some((p) => p.level === 'error') ? 'failing'
    : problems.some((p) => p.level === 'warn') ? 'degraded' : 'ok';
  return { status, problems };
}

// ── Measuring ────────────────────────────────────────────────────────────────

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lastWindow: EventLoopDelay | null = null;
const startedAt = Date.now();

const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
const snapshot = (h: NonNullable<typeof histogram>): EventLoopDelay | null => (h.count
  ? { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) } : null);

/** Watch the main thread's event loop from now on, a window at a time. */
export function startHealthMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const h = histogram;
  setInterval(() => {
    lastWindow = snapshot(h) || lastWindow;
    h.reset();
  }, WINDOW_MS).unref();
}

/** The event loop's delay over the last window (or this one, before the first ends). */
function eventLoopDelay(): EventLoopDelay | null {
  return lastWindow || (histogram ? snapshot(histogram) : null);
}

let version: string | null = null;
function appVersion(): string {
  if (version === null) {
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version);
    } catch (_) {
      version = 'unknown';
    }
  }
  return version;
}

/** The auto show, as far as health needs to know it. */
export interface HealthDeps {
  autoShow?: { status?: string; error?: string | null; running?: boolean } | null;
}

/** The server's health now. */
export function health({ autoShow = null }: HealthDeps = {}) {
  const engine = engineStatus();
  const memory = process.memoryUsage();
  const since = Date.now() - RECENT_ERRORS_MS;
  const recentErrors = buffer.since(0, { level: 'error', limit: 1000 }).filter((e) => !e.previous && e.time >= since);
  const lastError = recentErrors.at(-1) || null;
  const inputs: HealthInputs = {
    engine,
    eventLoop: eventLoopDelay(),
    rssMb: memory.rss / 1024 / 1024,
    errors: { count: recentErrors.length, last: lastError && { component: lastError.component, msg: lastError.msg } },
    supervisor: supervision(),
    auto: autoShow ? { status: String(autoShow.status || 'idle'), error: autoShow.error ?? null } : null,
  };
  const { status, problems } = assess(inputs);
  return {
    ok: status !== 'failing',
    status,
    problems,
    version: appVersion(),
    node: process.version,
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    uptimeS: Math.round(process.uptime()),
    supervisor: inputs.supervisor,
    engine,
    eventLoop: inputs.eventLoop,
    memory: { rssMb: Math.round(inputs.rssMb), heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024) },
    outputs: {
      artnet: { enabled: state.artnet.enabled !== false, host: state.artnet.host },
      hue: output.getHueStatus(),
    },
    auto: autoShow ? { status: inputs.auto?.status, running: !!autoShow.running, error: inputs.auto?.error ?? null } : null,
    log: { errors10m: recentErrors.length, lastError },
  };
}
