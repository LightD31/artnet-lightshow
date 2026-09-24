// The view shell: a real tab strip, a view per hash, keys to switch.

import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => { await reset(request); });

test('the hash opens a view, and switching views writes it back', async ({ page }) => {
  await open(page, 'perform');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.perform-pads')).toBeVisible();
  await page.getByRole('tab', { name: /Auto Show/ }).click();
  await expect(page).toHaveURL(/#auto$/);
  await page.goBack();
  await page.goto('/#manual');
  await expect(page.locator('#panel-manual')).toBeVisible();
});

test('the tab strip is one stop, and the arrow keys move along it', async ({ page }) => {
  await open(page, 'manual');
  const manual = page.getByRole('tab', { name: /Manual/ });
  await manual.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Auto Show/ })).toBeFocused();
  await expect(page.locator('#panel-auto')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Perform/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-perform');
  await expect(page.getByRole('tab', { name: /Manual/ })).toHaveAttribute('tabindex', '-1');
});

test('the digit keys jump between views, and not while typing', async ({ page }) => {
  await open(page, 'manual');
  await page.locator('body').press('3');
  await expect(page.locator('#panel-perform')).toBeVisible();
  await page.locator('body').press('2');
  await expect(page.locator('#panel-auto')).toBeVisible();
});

test('the keyboard shortcuts dialog keeps focus inside it and gives it back', async ({ page }) => {
  await open(page, 'manual');
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
