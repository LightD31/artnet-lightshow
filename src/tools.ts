import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as pythonEnv from './python-env.ts';

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

export function scriptsDirs(python: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = pathFor(platform);
  const dir = p.dirname(python);
  return platform === 'win32' ? [dir, p.join(dir, 'Scripts')] : [dir];
}

export interface EnvToolOptions {
  python?: string | null;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

function analysisPython(): string | null {
  const info = pythonEnv.resolve();
  return info.ok ? (info.executable || info.exe) : null;
}

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
  from: 'path' | 'environment';
}

let ffmpeg$: Promise<Ffmpeg | null> | null = null;

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

export async function ffmpegCommand(options: Parameters<typeof ffmpeg>[0] = {}): Promise<string> {
  return (await ffmpeg(options))?.command ?? 'ffmpeg';
}

export function _reset(): void {
  ffmpeg$ = null;
}
