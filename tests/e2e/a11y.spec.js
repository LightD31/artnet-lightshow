// axe-core on every view in every theme: no violations.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

test.beforeEach(async ({ request }) => { await reset(request); });

for (const theme of ['dark', 'light', 'red']) {
  for (const view of ['manual', 'auto', 'perform', 'rig', 'rig/profiles', 'rig/outputs', 'sources', 'settings', 'preflight']) {
    test(`${view}, ${theme} theme`, async ({ page }) => {
      await open(page, view, { theme });
      if (view === 'preflight') {
        test.setTimeout(60_000);
        await page.getByRole('button', { name: 'Run the check' }).click();
        await page.locator('.preflight-summary').waitFor({ timeout: 45_000 });
      }
      await page.waitForTimeout(400);
      await page.addScriptTag({ path: AXE });
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, { resultTypes: ['violations'] });
        return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      });
      expect(violations).toEqual([]);
    });
  }
}

test('the setup wizard, every step', async ({ page, request }) => {
  test.setTimeout(90_000);
  await request.put('/api/settings', { data: { setup: { completed: false } } });
  try {
    await open(page, 'manual');
    const dialog = page.getByRole('dialog', { name: /Set up the rig/ });
    await page.addScriptTag({ path: AXE });
    for (const step of ['Welcome', 'Outputs', 'Fixtures', 'Placement', 'Music', 'Check']) {
      await dialog.getByRole('button', { name: new RegExp(`^(\\d\\. )?${step}$`) }).click();
      await expect(dialog.locator('#wizard-title')).toContainText(step);
      if (step === 'Check') await expect(dialog.locator('.preflight-summary')).toBeVisible({ timeout: 45_000 });
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document.querySelector('.wizard'), { resultTypes: ['violations'] });
        return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      });
      expect(violations, step).toEqual([]);
    }
  } finally {
    await request.put('/api/settings', { data: { setup: { completed: true } } });
  }
});
