import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function shouldOpenBrowser({ env = process.env, argv = process.argv, restarts = 0 }:
  { env?: NodeJS.ProcessEnv; argv?: string[]; restarts?: number } = {}): boolean {
  return env.LIGHTSHOW_PACKAGED === '1' && restarts === 0
    && env.LIGHTSHOW_OPEN_BROWSER !== '0' && !argv.includes('--no-browser');
}

type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function openBrowser(url: string, { platform = process.platform, spawner = spawn as Spawner }:
  { platform?: NodeJS.Platform; spawner?: Spawner } = {}): boolean {
  const [command, args] = platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawner(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no browser to open it with */ });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}
