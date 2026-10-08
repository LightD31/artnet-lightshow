// The view shell: a real tab strip, a view per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await page.getByRole('tab', { name: /Auto Show/ }).click();
  await expect(page).toHaveURL(/#auto(?:\/show)?$/);
  await page.goBack();
  await page.goto('/#effects');
  await expect(page.locator('#panel-effects')).toBeVisible();
});

test('the tab strip is one stop, and the arrow keys move along it', async ({ page }) => {
  await open(page, 'effects');
  const manual = page.getByRole('tab', { name: /Effects/ });
  await manual.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Auto Show/ })).toBeFocused();
  await expect(page.locator('#panel-auto')).toBeVisible();
  // The live views, then the setup views: End is the last of them all.
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Preflight/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-preflight')).toHaveAttribute('aria-labelledby', 'tab-preflight');
  await expect(page.getByRole('tab', { name: /Effects/ })).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Perform/ })).toBeFocused();
});

test('the digit keys jump between views, and not while typing', async ({ page }) => {
  await open(page, 'effects');
  await page.locator('body').press('1');
  await expect(page.locator('#panel-perform')).toBeVisible();
  await page.locator('body').press('3');
  await expect(page.locator('#panel-auto')).toBeVisible();
});

test('the keyboard shortcuts dialog keeps focus inside it and gives it back', async ({ page }) => {
  await open(page, 'effects');
  const opener = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
});

for (const [old, canonical, panel] of [['manual', 'effects', 'effects'], ['timeline', 'auto/timeline', 'auto'], ['matrix', 'perform/matrix', 'perform']]) {
  test(`old ${old} bookmarks open ${canonical}`, async ({ page }) => {
    await open(page, old);
    await expect(page).toHaveURL(new RegExp(`#${canonical}$`));
    await expect(page.locator(`#panel-${panel}`)).toBeVisible();
  });
}

test('a new browser opens Perform and can restart a frozen look', async ({ page, request }) => {
  await request.post('/api/set', { data: { running: false } });
  await page.goto('/');
  await expect(page.locator('#panel-perform')).toBeVisible();
  await page.getByRole('button', { name: 'Play look', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Freeze look', exact: true })).toBeVisible();
});
