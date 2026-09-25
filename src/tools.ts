import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as pythonEnv from './python-env.ts';

/**
 * The programs the analysis needs besides Python — yt-dlp, the JavaScript
 * runtime yt-dlp solves YouTube's challenges with, and ffmpeg — found on PATH
 * first, then in the analysis environment.
 *
 * The locked environment (`uv sync`, or Sources → Analysis → Set up) installs
 * all three: yt-dlp, Deno beside it (yt-dlp[deno]), and an ffmpeg binary
 * (imageio-ffmpeg). But an environment's scripts folder is on nobody's PATH
 * unless it has been activated, and never for the packaged build, started from
 * a shortcut — so looking only on PATH, as the server used to, found none of
 * them. PATH still comes first: a tool the operator installed is the one they
 * meant.
 */

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** Where an interpreter's environment keeps its programs. */
export function scriptsDirs(python: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = pathFor(platform);
  const dir = p.dirname(python);
  // A virtual environment's python sits in its scripts folder; a Windows
  // installation's python.exe sits above its Scripts folder.
  return platform === 'win32' ? [dir, p.join(dir, 'Scripts')] : [dir];
}

export interface EnvToolOptions {
  /** The analysis interpreter; its environment is searched. */
  python?: string | null;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

function analysisPython(): string | null {
  const info = pythonEnv.resolve();
  return info.ok ? (info.executable || info.exe) : null;
}

/** A program in the analysis environment, by name; null when it has none. */
export function envTool(name: string, {
  python = analysisPython(), platform = process.platform, exists = fs.existsSync,
}: EnvToolOptions = {}): string | null {
  const p = pathFor(platform);
  if (!python || !p.isAbsolute(python)) return null;
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of scriptsDirs(python, platform)) {
    const candidate = p.join(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * A program on PATH, as the shell would find it (with PATHEXT's extensions on
 * Windows); null when there is none. Looked for, not run: a stand-in that
 * does not answer `-version` is still the one a spawn would start.
 */
export function onPath(name: string, {
  env = process.env, platform = process.platform, exists = fs.existsSync,
}: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): string | null {
  const p = pathFor(platform);
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** The ffmpeg imageio-ffmpeg installed in the analysis environment, or null. */
function envFfmpeg(python: string | null): Promise<string | null> {
  if (!python) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(python, ['-c', 'import imageio_ffmpeg, sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'],
      { timeout: 30000, windowsHide: true }, (err, stdout) => {
        const file = String(stdout || '').trim();
        resolve(!err && file && fs.existsSync(file) ? file : null);
      });
  });
}

export interface Ffmpeg {
  command: string;
  /** Where it was found. */
  from: 'path' | 'environment';
}

let ffmpeg$: Promise<Ffmpeg | null> | null = null;

/**
 * The ffmpeg to run: the one on PATH, else the analysis environment's; null
 * when there is neither. Asked once; not finding one is not remembered, so
 * installing it while the server runs is picked up by the next conversion.
 */
export function ffmpeg({ python = analysisPython }: { python?: () => string | null } = {}): Promise<Ffmpeg | null> {
  if (!ffmpeg$) {
    ffmpeg$ = (async (): Promise<Ffmpeg | null> => {
      if (onPath('ffmpeg')) return { command: 'ffmpeg', from: 'path' };
      const file = await envFfmpeg(python());
      return file ? { command: file, from: 'environment' } : null;
    })().then((found) => {
      if (!found) ffmpeg$ = null;
      return found;
    });
  }
  return ffmpeg$;
}

/** The ffmpeg command to spawn: bare `ffmpeg` when there is none, to fail as it always has. */
export async function ffmpegCommand(options: Parameters<typeof ffmpeg>[0] = {}): Promise<string> {
  return (await ffmpeg(options))?.command ?? 'ffmpeg';
}

/** Forget what was found (tests; an environment just set up). */
export function _reset(): void {
  ffmpeg$ = null;
}
