// Running the server from the page: the log and health in the drawer, and
// the settings waiting on a restart, with the button that restarts it.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

test.beforeEach(async ({ request }) => { await reset(request); });

async function openLog(page) {
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  return page.getByRole('log', { name: 'Server log' });
}

test('the log: what the server has said, filtered, with its health above', async ({ page }) => {
  await open(page, 'manual');
  const log = await openLog(page);
  await expect(log.locator('.log-entry').first()).toBeVisible();
  await expect(log).toContainText('starting');
  await expect(page.locator('.log-health')).toContainText(/Healthy|Degraded/);
  await expect(page.locator('.log-health')).toContainText('not supervised');

  await page.getByRole('searchbox', { name: 'Filter the log' }).fill('MIDI');
  await expect(log.locator('.log-entry').first()).toContainText('MIDI');
  const shown = await log.locator('.log-entry').allTextContents();
  expect(shown.every((line) => /midi/i.test(line))).toBe(true);

  await page.getByRole('searchbox', { name: 'Filter the log' }).fill('');
  await page.getByLabel('Show').selectOption('error');
  await expect(log.locator('.log-entry.lvl-info')).toHaveCount(0);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Paused' })).toHaveAttribute('aria-pressed', 'true');
});

for (const theme of ['dark', 'light', 'red']) {
  test(`the log drawer, ${theme} theme, has no axe violations`, async ({ page }) => {
    await open(page, 'manual', { theme });
    const log = await openLog(page);
    await expect(log.locator('.log-entry').first()).toBeVisible();
    await expect(page.locator('.log-health')).toBeVisible();
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.querySelector('.bottom-drawer'), { resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    });
    expect(violations).toEqual([]);
  });
}

test('a setting waiting on a restart says so, and restarting says there is no supervisor here', async ({ page, request }) => {
  const port = (await (await request.get('/api/settings')).json()).settings.server.port;
  await request.put('/api/settings', { data: { server: { port: port + 1 } } });
  try {
    await open(page, 'settings');
    const banner = page.getByRole('region', { name: 'Waiting on a restart' });
    await expect(banner).toContainText('Server & access: Port');
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.querySelector('.restart-banner'), { resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.impact} ${v.id}`);
    });
    expect(violations).toEqual([]);
    await banner.getByRole('button', { name: 'Restart now' }).click();
    await expect(banner).toContainText('blacks out for a few seconds');
    await banner.getByRole('button', { name: 'Restart the server' }).click();
    // The e2e server runs without the supervisor (serve.js).
    await expect(banner.getByRole('status')).toContainText('not running under the supervisor');
  } finally {
    await request.put('/api/settings', { data: { server: { port } } });
  }
  await page.reload();
  await expect(page.getByRole('region', { name: 'Waiting on a restart' })).toHaveCount(0);
});
