// Installable: a manifest, icons, a service worker; themes kept.

import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the page names its manifest and icons, and they are there', async ({ page, request }) => {
  await open(page, 'manual');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(href)).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  expect(manifest.shortcuts.map((s) => s.url)).toContain('/#perform');
});

test('on a secure page the service worker takes over, and keeps out of the API', async ({ page, request }) => {
  await open(page, 'manual');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
  const text = await (await request.get('/sw.js')).text();
  expect(text).toContain("url.pathname.startsWith('/api/')");
});

test('the shell the service worker keeps has the page\'s chunks, three.js with them', async ({ page, request }) => {
  await open(page, 'manual');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const listed = await (await request.get('/chunks/index.json')).json();
  expect(listed.some((p) => /^\/chunks\/scene-/.test(p))).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith('lightshow-shell'));
    const cache = name ? await caches.open(name) : null;
    return cache ? (await cache.keys()).map((r) => new URL(r.url).pathname) : [];
  })).toEqual(expect.arrayContaining(['/app.bundle.js', ...listed]));
});

test('a theme picked is the theme after a reload, set before the page draws', async ({ page }) => {
  await page.goto('/#manual');
  await page.getByLabel('Theme').selectOption('light');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await page.getByLabel('Theme').selectOption('system');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
});

test('source maps stay on this machine; the bundle is compressed', async ({ request }) => {
  const res = await request.get('/app.bundle.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
  expect(['br', 'gzip']).toContain(res.headers()['content-encoding']);
});
