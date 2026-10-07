// The Effects sheet: typing a hex colour, and focus after a button goes away.
import { test, expect } from '@playwright/test';
import { open, reset } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await reset(request);
});

async function sheetFor(page, name) {
  await open(page, 'effects');
  await page.getByLabel('Search effects').fill(name);
  await page.getByRole('button', { name: `Edit ${name}` }).first().click();
  return page.getByRole('dialog', { name: 'Edit effect' });
}

async function withPalette(sheet) {
  const own = sheet.getByLabel('The look\'s own colours');
  if (await own.isChecked()) await own.uncheck();
  return sheet.getByLabel('Colour 1', { exact: true });
}

test('a hex colour typed key by key stays as typed until Enter', async ({ page }) => {
  const sheet = await sheetFor(page, 'Neon Domino');
  const hex = await withPalette(sheet);
  await hex.fill('');
  await hex.pressSequentially('#ff0');
  await expect(hex).toHaveValue('#ff0');
  await hex.pressSequentially('000');
  await expect(hex).toHaveValue('#ff0000');
  await hex.press('Enter');
  await expect(hex).toHaveValue('#FF0000');
});

test('an unfinished hex colour blocks Save copy', async ({ page }) => {
  const sheet = await sheetFor(page, 'Neon Domino');
  const hex = await withPalette(sheet);
  await sheet.getByRole('button', { name: 'Save as…' }).click();
  await expect(sheet.getByRole('button', { name: 'Save copy' })).toBeEnabled();
  await hex.fill('#12');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByRole('button', { name: 'Save copy' })).toBeDisabled();
});

test('after Revert removes itself, Escape still closes the sheet and Tab stays in it', async ({ page }) => {
  const sheet = await sheetFor(page, 'Neon Domino');
  await sheet.getByLabel('Stagger', { exact: true }).fill('0.25');
  await sheet.getByRole('button', { name: 'Revert' }).click();
  await expect(sheet.getByRole('button', { name: 'Revert' })).toHaveCount(0);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!window.document.activeElement.closest('.effect-sheet'))).toBe(true);
  await page.evaluate(() => window.document.activeElement.blur());
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('Apply recommended drops an unfinished hex colour', async ({ page }) => {
  const sheet = await sheetFor(page, 'Neon Domino');
  const hex = await withPalette(sheet);
  await hex.fill('#12');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await sheet.locator('.insp-actions').getByRole('button', { name: 'Apply recommended' }).click();
  await expect(sheet.getByLabel('Colour 1', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByLabel('Colour 1', { exact: true })).toHaveValue(/^#[0-9A-F]{6}([0-9A-F]{2})?$/);
});

test('a number typed into Cadence is not clamped mid-typing', async ({ page }) => {
  const sheet = await sheetFor(page, 'Drip');
  const cadence = sheet.getByLabel('Cadence', { exact: true });
  await cadence.fill('');
  await cadence.pressSequentially('0.5');
  await expect(cadence).toHaveValue('0.5');
  await cadence.blur();
  await expect(cadence).toHaveValue('0.5');
});
