// axe-core on every view in every theme: no violations.

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { open, reset } from './helpers.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

test.beforeEach(async ({ request }) => { await reset(request); });

for (const theme of ['dark', 'light', 'red']) {
  for (const view of ['manual', 'auto', 'perform']) {
    test(`${view}, ${theme} theme`, async ({ page }) => {
      await open(page, view, { theme });
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
