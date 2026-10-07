import path from 'node:path';

const APP_ROOT = path.join(import.meta.dirname, '..', '..');

export function dataDir(): string {
  const dir = process.env.LIGHTSHOW_DATA_DIR;
  return dir && dir.trim() ? path.resolve(dir) : APP_ROOT;
}

export function configDir(): string {
  const dir = process.env.LIGHTSHOW_CONFIG_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'config');
}

export function configFile(name: string): string {
  return path.join(configDir(), name);
}

export function cacheDir(): string {
  const dir = process.env.LIGHTSHOW_CACHE_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'cache');
}

export function logDir(): string {
  const dir = process.env.LIGHTSHOW_LOG_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'logs');
}

export function venvDir(): string {
  return path.join(dataDir(), '.venv');
}

export function venvPython(venv: string = venvDir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
}

export function appDir(): string {
  return APP_ROOT;
}
