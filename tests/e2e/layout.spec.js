import { test, expect } from '@playwright/test';
import { open } from './helpers.js';

test('portrait pads precede strobe, meters and colour libraries', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page, 'perform');
  const pads = await page.locator('.perform-pads').boundingBox();
  for (const selector of ['.strobe-pad', '.perform-side', '.perform-override', '.perform-palettes']) {
    expect((await page.locator(selector).boundingBox()).y).toBeGreaterThan(pads.y);
  }
});

test('landscape blackout and tap fit on the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'perform');
  const utility = await page.locator('.perform-utility').boundingBox();
  expect(utility.y + utility.height).toBeLessThanOrEqual(768);
});

test('short landscape keeps blackout and tap in reach', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await open(page, 'perform');
  const utility = await page.locator('.perform-utility').boundingBox();
  expect(utility.y).toBeGreaterThanOrEqual(0);
  expect(utility.y + utility.height).toBeLessThanOrEqual(400);
});

test('catalogue tools leave the first favourite reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'manual');
  const star = page.locator('.effects-deck .effect-star').first();
  await star.click({ trial: true });
});

test('view navigation stays above the scrolled catalogue', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, 'manual');
  await page.evaluate(() => { document.body.scrollTop = 600; });
  await expect.poll(async () => (await page.locator('.mode-nav').boundingBox()).y).toBeGreaterThanOrEqual(0);
  const nav = await page.locator('.mode-nav').boundingBox();
  expect((await page.locator('.effects-tools').boundingBox()).y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
});

test('phone controls leave the Matrix colours on the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await open(page, 'matrix');
  const cell = await page.locator('.matrix-cell').first().boundingBox();
  expect(cell.y + cell.height).toBeLessThan(800);
  expect((await page.locator('.command-bar').boundingBox()).height).toBeLessThan(70);
});

test('phone transport stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await open(page, 'perform');
  const transport = await page.locator('.perform-transport').boundingBox();
  expect(transport.x + transport.width).toBeLessThanOrEqual(400);
});


test('catalogue controls scroll clear of sticky tools', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await open(page, 'manual');
  const group = page.locator('.effects-group summary').first();
  await group.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const tools = await page.locator('.effects-tools').boundingBox();
  const target = await group.boundingBox();
  expect(target.y).toBeGreaterThanOrEqual(tools.y + tools.height);
  await group.click();
  await expect(page.locator('.effects-group').first()).toHaveAttribute('open', '');
});
