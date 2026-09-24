// Shared by the end-to-end specs: read and set the server's state over REST,
// and open the page on a view with a clean look.

import { E2E_TRACK } from './paths.js';

export async function state(request) {
  const res = await request.get('/api/state');
  return res.json();
}

export async function set(request, patch) {
  const res = await request.post('/api/set', { data: patch });
  if (!res.ok()) throw new Error(`POST /api/set ${res.status()}: ${await res.text()}`);
}

/** The look every spec starts from. */
export async function reset(request) {
  await set(request, {
    masterDimmer: 255, masterBlackout: false, energyOverride: null, running: true,
    bpm: 120, beatDivision: 1, pattern: 'chase', pixelMap: 'stage',
  });
}

/** The page on `view`, connected and drawn. */
export async function open(page, view = 'manual', { theme = 'dark' } = {}) {
  await page.addInitScript((t) => {
    try { localStorage.setItem('lightshow.theme', t); } catch { /* private mode */ }
  }, theme);
  await page.goto(`/#${view}`);
  await page.locator('.offline-veil').waitFor({ state: 'detached' });
  // A view with tabs of its own is named with them: rig/outputs.
  await page.locator(`#panel-${view.split('/')[0]}`).waitFor();
}

/** Poll the server until `check(state)` holds, or fail with the last state. */
export async function until(request, check, { timeout = 3000 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await state(request);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition never held; last state: ${JSON.stringify(last).slice(0, 400)}`);
}

/**
 * Load the analysed track the end-to-end server seeds (serve.js): the show's
 * timeline without Python. `unloadTrack` puts the auto show back as it was.
 */
export async function loadTrack(request) {
  const res = await request.post('/api/auto/analyze', { data: { source: E2E_TRACK } });
  if (!res.ok()) throw new Error(`POST /api/auto/analyze ${res.status()}: ${await res.text()}`);
}

export async function unloadTrack(request) {
  await request.post('/api/auto/reset', { data: {} });
}
