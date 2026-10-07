import { execFile } from 'node:child_process';
import { isSea } from 'node:sea';
import { envTool } from './tools.ts';

/**
 * Which yt-dlp to run, and what it needs to be told.
 *
 * yt-dlp is looked for on PATH, then in the analysis environment, which
 * installs it (tools.ts): nothing puts that environment's scripts folder on
 * PATH.
 *
 * Since 2025.11.12, yt-dlp needs an external JavaScript runtime to solve
 * YouTube's challenges; without one, YouTube downloads degrade and then fail.
 * Only Deno is enabled by default, which the analysis environment installs
 * beside yt-dlp (yt-dlp[deno]), where yt-dlp finds it by itself — and every
 * operator has Node, because it is what runs this server, so yt-dlp is
 * pointed at this very executable too. Except in the packaged build: its
 * executable is the server itself, not a Node that runs what it is given
 * (scripts/sea-main.cjs), so there it is the environment's Deno, named
 * outright in case the yt-dlp that was found is not the environment's own.
 *
 * Older builds do not know the option and would refuse to run at all with it,
 * so it is only passed to a version that understands it. The version is asked
 * once and remembered; a failed probe is not remembered, so installing yt-dlp
 * while the server runs is picked up on the next download.
 */

// The first release that requires, and accepts, --js-runtimes.
const JS_RUNTIME_SINCE = '2025.11.12';

export interface YtDlp {
  command: string;
  version: string;
  /** Where it was found. */
  from: 'path' | 'environment';
}

let found$: Promise<YtDlp | null> | null = null;

function versionOf(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim().split(/\s+/)[0] || null);
    });
  });
}

async function probe(inEnvironment: () => string | null): Promise<YtDlp | null> {
  const onPath = await versionOf('yt-dlp');
  if (onPath) return { command: 'yt-dlp', version: onPath, from: 'path' };
  const inEnv = inEnvironment();
  const version = inEnv ? await versionOf(inEnv) : null;
  return inEnv && version ? { command: inEnv, version, from: 'environment' } : null;
}

/** The yt-dlp to run, or null when there is none. */
function find({ inEnvironment = () => envTool('yt-dlp') }: { inEnvironment?: () => string | null } = {}): Promise<YtDlp | null> {
  if (!found$) {
    found$ = probe(inEnvironment).then((found) => {
      if (!found) found$ = null;
      return found;
    });
  }
  return found$;
}

/** The installed yt-dlp's version string, e.g. "2025.11.12", or null. */
async function version(): Promise<string | null> {
  return (await find())?.version ?? null;
}

/** The yt-dlp command to spawn: bare `yt-dlp` when there is none, to fail as it always has. */
async function command(options: Parameters<typeof find>[0] = {}): Promise<string> {
  return (await find(options))?.command ?? 'yt-dlp';
}

/** yt-dlp versions are dates; compare them as YYYYMMDD numbers. */
function dateOf(v: unknown): number {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(String(v || ''));
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/** Does this version need, and understand, --js-runtimes? */
function needsJsRuntime(v: unknown): boolean {
  return dateOf(v) >= dateOf(JS_RUNTIME_SINCE);
}

export interface RuntimeOptions {
  /** This server's Node. */
  execPath?: string;
  /** Running as the packaged single executable, which is no Node for yt-dlp. */
  sea?: boolean;
  /** The analysis environment's Deno, if it has one. */
  deno?: string | null;
}

/** The arguments that hand yt-dlp a JavaScript runtime, for this version. */
function runtimeArgs(v: unknown, {
  execPath = process.execPath, sea = isSea(), deno,
}: RuntimeOptions = {}): string[] {
  if (!needsJsRuntime(v)) return [];
  if (!sea) return ['--js-runtimes', `node:${execPath}`];
  const runtime = deno === undefined ? envTool('deno') : deno;
  return runtime ? ['--js-runtimes', `deno:${runtime}`] : [];
}

/** The JavaScript runtime yt-dlp will have, in words (the pre-show check). */
function runtimeName({ sea = isSea(), deno }: Omit<RuntimeOptions, 'execPath'> = {}): string | null {
  if (!sea) return `Node ${process.versions.node} (this server)`;
  const runtime = deno === undefined ? envTool('deno') : deno;
  return runtime ? 'Deno, from the analysis environment' : null;
}

function _reset(): void { found$ = null; }

export {
  find,
  version,
  command,
  needsJsRuntime,
  runtimeArgs,
  runtimeName,
  dateOf,
  JS_RUNTIME_SINCE,
  _reset,
};
