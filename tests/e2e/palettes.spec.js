import { test, expect } from '@playwright/test';
import { open, reset, until } from './helpers.js';

test.beforeEach(async ({ request }) => {
  await reset(request);
  await request.post('/api/set', { data: { basePalette: null, paletteOverride: null } });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/set', { data: { basePalette: null, paletteOverride: null } });
});

test('the shared editor keeps all emitters through RGB edits and palette reuse', async ({ page, request }) => {
  await open(page, 'perform');
  const strip = page.locator('.palette-strip');
  await strip.getByRole('button', { name: 'Base', exact: true }).click();
  await strip.getByRole('button', { name: 'Edit palette' }).click();
  const editor = strip.locator('.palette-editor');
  const hex = editor.getByLabel('Colour 1', { exact: true });
  await hex.fill('#102030405060');
  await hex.press('Enter');
  await editor.getByLabel('Colour 1 picker').fill('#abcdef');
  await expect(hex).toHaveValue('#ABCDEF405060');
  await editor.locator('.palette-emitters').first().locator('summary').click();
  await editor.getByLabel('Colour 1 UV', { exact: true }).fill('255');
  await expect(hex).toHaveValue('#ABCDEF4050FF');
  await editor.locator('.palette-gradients > summary').click();
  await editor.getByRole('button', { name: 'Add gradient', exact: true }).click();
  await editor.getByLabel('Gradient 1 name', { exact: true }).fill('Night');
  await editor.getByRole('button', { name: 'Add gradient set' }).click();
  await editor.getByLabel('Active set', { exact: true }).selectOption('Set 1');
  await editor.getByRole('button', { name: 'Save as palette…' }).click();
  await editor.getByLabel('Palette name', { exact: true }).fill('Browser full palette');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/palettes') && r.request().method() === 'POST');
  await editor.getByRole('button', { name: 'Save palette', exact: true }).click();
  const { palette } = await (await saved).json();
  try {
    await strip.getByRole('button', { name: 'Apply palette', exact: true }).click();
    await until(request, (s) => s.basePalette?.colours[0] === '#ABCDEF4050FF' && s.basePalette?.gradientSet === 'Set 1');
    await strip.getByRole('button', { name: 'Override', exact: true }).click();
    await strip.locator(`[data-palette="${palette.id}"]`).click();
    await until(request, (s) => s.overridePalette?.gradientSet === 'Set 1' && s.paletteOverrideId === palette.id);
    await strip.getByRole('button', { name: 'Off', exact: true }).click();
    await until(request, (s) => s.overridePalette === null);
  } finally { await request.delete(`/api/palettes/${palette.id}`); }
});

test('invalid gradient stops cannot be applied', async ({ page }) => {
  await open(page, 'perform');
  const strip = page.locator('.palette-strip');
  await strip.getByRole('button', { name: 'Edit palette' }).click();
  await strip.locator('.palette-gradients > summary').click();
  await strip.getByRole('button', { name: 'Add gradient', exact: true }).click();
  await strip.getByLabel('Gradient 1 stop 2 position').fill('0');
  await expect(strip.getByRole('button', { name: 'Apply palette', exact: true })).toBeDisabled();
  await expect(strip.getByRole('alert')).toContainText('in increasing order');
});
