import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/**
 * The packaged build opens the app in the browser when it starts: it was
 * double-clicked, and a console window full of log lines is no answer to
 * "where is it?". Only on its first start — not each time the supervisor
 * starts it again — and not when told not to (--no-browser,
 * LIGHTSHOW_OPEN_BROWSER=0). A server run from a checkout never does.
 */
export function shouldOpenBrowser({ env = process.env, argv = process.argv, restarts = 0 }:
  { env?: NodeJS.ProcessEnv; argv?: string[]; restarts?: number } = {}): boolean {
  return env.LIGHTSHOW_PACKAGED === '1' && restarts === 0
    && env.LIGHTSHOW_OPEN_BROWSER !== '0' && !argv.includes('--no-browser');
}

type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Open `url` in the default browser, without waiting for it. False when
 * there was nothing to open it with; a browser that fails later is not this
 * server's problem.
 */
export function openBrowser(url: string, { platform = process.platform, spawner = spawn as Spawner }:
  { platform?: NodeJS.Platform; spawner?: Spawner } = {}): boolean {
  // rundll32 rather than `cmd /c start`: cmd would read the & in a URL as
  // the end of the command.
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
