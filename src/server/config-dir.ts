import path from 'node:path';

/**
 * Where the server keeps what it saves: settings, the show, cues and the MIDI
 * map. `config/` in the checkout, unless LIGHTSHOW_CONFIG_DIR names another —
 * so an end-to-end test runs a real server against a throwaway directory
 * rather than the operator's own show, and a packaged build can keep it
 * somewhere writable.
 */
export function configDir(): string {
  const dir = process.env.LIGHTSHOW_CONFIG_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(import.meta.dirname, '..', '..', 'config');
}

export function configFile(name: string): string {
  return path.join(configDir(), name);
}

/**
 * Where the server keeps what it can make again: the analysis cache.
 * `cache/` in the checkout, unless LIGHTSHOW_CACHE_DIR names another — a
 * bigger disk for a long set list, or, for an end-to-end test, a throwaway
 * directory seeded with an analysed track so no test needs Python.
 */
export function cacheDir(): string {
  const dir = process.env.LIGHTSHOW_CACHE_DIR;
  return dir && dir.trim() ? path.resolve(dir) : path.join(import.meta.dirname, '..', '..', 'cache');
}
