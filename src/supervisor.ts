import { fork as nodeFork } from 'node:child_process';
import fs from 'node:fs';
import { isSea } from 'node:sea';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import { configFile } from './server/config-dir.ts';
import { EXIT_CONFIG, EXIT_RESTART } from './server/supervised.ts';
import type { LastExit } from './server/supervised.ts';

/**
 * Keep the server running through a crash.
 *
 * `npm start` runs this: a small parent process that starts the server as its
 * child and starts it again when it dies — a native module that faulted, the
 * memory running out — or stops responding: the server heartbeats every
 * second (supervised.ts), and one whose main thread has gone quiet for fifteen
 * seconds is killed and started again. Each new run is told it is one
 * (LIGHTSHOW_RECOVER), and puts the look back before its first frame
 * (look-store.ts), so the rig comes back as it was rather than on a default
 * chase.
 *
 * Restarts back off (half a second, then longer, to ten) while the server
 * keeps dying, and reset once a run has lasted a minute. A server that dies
 * three times before it has even started is not going to start: that, and an
 * exit saying the configuration will not let it (EXIT_CONFIG), end the
 * supervisor too. An exit asking to be started again (EXIT_RESTART, for a
 * setting that only applies on a restart) is done at once. A clean exit
 * (Ctrl-C, a service manager's stop) ends both.
 *
 * Deezer's downloads need OpenSSL's legacy provider (Blowfish), which is
 * nothing anything else here should have: it is turned on for the server only
 * when a Deezer ARL is set (deezer.ts).
 *
 * Stopping asks the server over the IPC channel, where it blacks the rig out
 * before it exits, rather than with a signal: on Windows a signal sent to
 * another process is no signal at all but an immediate kill, and a DMX node
 * left without its blackout holds the last frame it was sent. A server that
 * has not gone after ten seconds is killed.
 *
 * In the packaged build the supervisor and the server are one executable
 * (a Node single executable application, scripts/sea-main.cjs), which runs
 * its own script whatever it is given and takes no Node flags on its command
 * line: the server is forked as that executable again, and the legacy
 * provider goes through NODE_OPTIONS instead.
 */

export interface SupervisorOptions {
  /** The server's entry point. */
  script: string;
  args?: string[];
  /** Node flags for the server (the supervisor's own, less what is its alone). */
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  /** Whether the server needs OpenSSL's legacy provider (a Deezer ARL is set). */
  legacyProvider?: () => boolean;
  fork?: (script: string, args: string[], options: ForkOptions) => ChildProcess;
  log?: (message: string) => void;
  now?: () => number;
  hangMs?: number;
  startupMs?: number;
  stopMs?: number;
  backoffMs?: number[];
  stableMs?: number;
  startupFailures?: number;
  /** How often the watchdog looks. */
  checkMs?: number;
  /**
   * Stop a server with no IPC channel left with a signal; on Windows the
   * console has sent it already, and kill() is not a signal.
   */
  forwardSignals?: boolean;
  /** Running as a single executable application: Node flags go in NODE_OPTIONS. */
  sea?: boolean;
}

export interface Supervisor {
  /** Stop the server (and with it the supervisor). */
  stop(signal?: NodeJS.Signals): void;
  /** Resolves with the exit code the supervisor should end with. */
  done: Promise<number>;
  /** How many times the server has been started again. */
  restarts(): number;
}

/** Whether settings.json has a Deezer ARL: Deezer's downloads need the legacy provider. */
export function deezerArlSet(file = configFile('settings.json')): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.deezer?.arl === 'string' && parsed.deezer.arl.trim() !== '';
  } catch (_) {
    return false;
  }
}

/** Why a run ended, in words. */
export function describeExit(code: number | null, signal: string | null,
  { hungMs = 0, requested = null }: { hungMs?: number; requested?: string | null } = {}): string {
  if (requested) return `restarted on request (${requested})`;
  if (hungMs) return `stopped responding for ${Math.round(hungMs / 1000)} s`;
  if (signal) return `killed by ${signal}`;
  return `crashed with exit code ${code}`;
}

export function supervise(options: SupervisorOptions): Supervisor {
  const {
    script, args = [], execArgv = [], env = process.env,
    legacyProvider = () => false,
    fork = nodeFork,
    log = (m: string) => {
      const t = new Date();
      const time = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      process.stderr.write(`${time} [supervisor] ${m}\n`);
    },
    now = Date.now,
    hangMs = 15_000,
    startupMs = 60_000,
    stopMs = 10_000,
    backoffMs = [500, 1000, 2000, 5000, 10_000],
    stableMs = 60_000,
    startupFailures = 3,
    checkMs = 1000,
    forwardSignals = process.platform !== 'win32',
    sea = isSea(),
  } = options;

  let child: ChildProcess | null = null;
  let restarts = 0;
  let crashesInARow = 0;
  let startupCrashes = 0;
  let lastExit: LastExit | null = null;
  let stopping = false;
  let settle: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => { settle = resolve; });

  const start = () => {
    if (stopping) return;
    const flags = [...execArgv.filter((f) => f !== '--openssl-legacy-provider')];
    if (legacyProvider()) flags.push('--openssl-legacy-provider');
    // A single executable takes its flags from NODE_OPTIONS, not its command line.
    const nodeOptions = sea
      ? [...String(env.NODE_OPTIONS || '').split(/\s+/).filter((f) => f && f !== '--openssl-legacy-provider'), ...flags].join(' ')
      : env.NODE_OPTIONS;
    const spawnedAt = now();
    let ready = false;
    let readyAt = 0;
    let lastBeat = spawnedAt;
    let hungFor = 0;
    let requested: string | null = null;

    const c = fork(script, args, {
      execArgv: sea ? [] : flags,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...env,
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        LIGHTSHOW_SUPERVISED: '1',
        LIGHTSHOW_RESTARTS: String(restarts),
        LIGHTSHOW_RECOVER: restarts > 0 ? '1' : '',
        LIGHTSHOW_LAST_EXIT: lastExit ? JSON.stringify(lastExit) : '',
      },
    });
    child = c;

    c.on('message', (message: unknown) => {
      const m = (message && typeof message === 'object' ? message : {}) as { type?: string; reason?: string };
      if (m.type === 'ready') { ready = true; readyAt = now(); lastBeat = readyAt; }
      else if (m.type === 'heartbeat') lastBeat = now();
      else if (m.type === 'restart') requested = String(m.reason || 'asked to');
    });

    // The watchdog: a server that stops beating, or never gets going, is hung.
    const watchdog = setInterval(() => {
      const t = now();
      const quiet = ready ? t - lastBeat : t - spawnedAt;
      if (quiet > (ready ? hangMs : startupMs)) {
        hungFor = quiet;
        log(ready
          ? `the server has not answered for ${Math.round(quiet / 1000)} s — restarting it`
          : `the server has not started after ${Math.round(quiet / 1000)} s — restarting it`);
        c.kill('SIGKILL');
      }
    }, checkMs);
    watchdog.unref?.();

    c.on('exit', (code, signal) => {
      clearInterval(watchdog);
      child = null;
      if (stopping) { settle(code ?? 0); return; }
      if (code === 0 && !requested) { settle(0); return; }
      if (code === EXIT_CONFIG) {
        log('the server cannot start with this configuration (see above) — not restarting it');
        settle(code);
        return;
      }

      const asked = requested || (code === EXIT_RESTART ? 'asked to' : null);
      const reason = describeExit(code, signal, { hungMs: hungFor, requested: asked });
      lastExit = { code, signal, reason, at: new Date().toISOString() };

      let delay = 0;
      if (!asked) {
        if (!ready) {
          startupCrashes++;
          if (startupCrashes >= startupFailures) {
            log(`the server ${reason} ${startupCrashes} times before it could start — giving up`);
            settle(code || 1);
            return;
          }
        } else {
          startupCrashes = 0;
        }
        if (ready && now() - readyAt >= stableMs) crashesInARow = 0;
        delay = backoffMs[Math.min(crashesInARow, backoffMs.length - 1)];
        crashesInARow++;
        log(`the server ${reason} — starting it again${delay ? ` in ${delay >= 1000 ? `${delay / 1000} s` : `${delay} ms`}` : ''}`);
      } else {
        log(`restarting the server (${asked})`);
      }
      restarts++;
      setTimeout(start, delay);
    });
  };

  start();

  return {
    stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (stopping) return;
      stopping = true;
      const c = child;
      if (!c) { settle(0); return; }
      // Asked, so it blacks out first (supervised.ts); a signal only when the
      // channel is gone.
      let asked = false;
      if (c.connected) {
        try { c.send({ type: 'stop', signal }); asked = true; } catch (_) { /* closed under us */ }
      }
      if (!asked && forwardSignals) c.kill(signal);
      // A server that will not stop in time is stopped.
      const timer = setTimeout(() => { if (child === c) c.kill('SIGKILL'); }, stopMs);
      timer.unref?.();
    },
    done,
    restarts: () => restarts,
  };
}

/** Run the server under a supervisor, as `npm start` does (server.js). */
export async function runSupervisor(script: string): Promise<never> {
  const supervisor = supervise({
    script,
    args: process.argv.slice(2),
    execArgv: process.execArgv,
    legacyProvider: deezerArlSet,
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => supervisor.stop(signal === 'SIGHUP' ? 'SIGTERM' : signal));
  }
  process.exit(await supervisor.done);
}
