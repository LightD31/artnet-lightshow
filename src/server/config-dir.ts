import path from 'node:path';

/** The checkout, or the packaged app's `app/` folder: the code's own files. */
const APP_ROOT = path.join(import.meta.dirname, '..', '..');

/**
 * Where the server keeps what it writes: the configuration, the analysis
 * cache, the logs and the analysis environment. The checkout itself unless
 * LIGHTSHOW_DATA_DIR names another — which the packaged build does (its
 * launcher, scripts/sea-main.cjs): a `data` folder beside the executable when
 * it was unzipped as a portable copy, the user's application data when it was
 * installed. The app's own files stay where they are either way.
 */
export function dataDir(): string {
  const dir = process.env.LIGHTSHOW_DATA_DIR;
  return dir && dir.trim() ? path.resolve(dir) : APP_ROOT;
}

/**
 * Where the server keeps what it saves: settings, the show, cues and the MIDI
 * map. `config/` in the data directory, unless LIGHTSHOW_CONFIG_DIR names
 * another — so an end-to-end test runs a real server against a throwaway
 * directory rather than the operator's own show.
 */
export function configDir(): string {
  const dir = process.env.LIGHTSHOW_CONFIG_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'config');
}

export function configFile(name: string): string {
  return path.join(configDir(), name);
}

/**
 * Where the server keeps what it can make again: the analysis cache.
 * `cache/` in the data directory, unless LIGHTSHOW_CACHE_DIR names another — a
 * bigger disk for a long set list, or, for an end-to-end test, a throwaway
 * directory seeded with an analysed track so no test needs Python.
 */
export function cacheDir(): string {
  const dir = process.env.LIGHTSHOW_CACHE_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'cache');
}

/**
 * Where the server writes its log (lightshow.log, and the older ones it
 * rotates out). `logs/` in the data directory, unless LIGHTSHOW_LOG_DIR names
 * another.
 */
export function logDir(): string {
  const dir = process.env.LIGHTSHOW_LOG_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(dataDir(), 'logs');
}

/**
 * The analysis environment: the `.venv` that `uv sync` makes from the
 * lockfile — by hand in a checkout, or from the app (python-setup.ts) — and
 * that the server prefers to any other Python (python-env.ts).
 */
export function venvDir(): string {
  return path.join(dataDir(), '.venv');
}

/** The interpreter inside a virtual environment. */
export function venvPython(venv: string = venvDir(), platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
}

/** The app's own files: `src/`, `public/`, `scripts/`, the Python lockfile. */
export function appDir(): string {
  return APP_ROOT;
}
