import { describe, test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';
import { horizontalOverflow } from './support/helpers.ts';

// The core product promise: pick a persona, the page re-renders with that
// persona's approved variant. Each test is a fresh browser = a fresh visitor.
describe('demo storefront personalization', { tags: ['demo'] }, () => {
  beforeEach(async ({ app, screen, browser }) => {
    await app.open('/demo/');
    await expect(screen.getByRole('heading', 'Light every moment.', { level: 1 })).toBeVisible();
    // the snippet has loaded and assigned a visitor id
    await expect.poll(() => browser.evaluate(() => typeof (window as any).prism?.identify)).toBe('function');
  });

  test('gift buyer sees the gift hero after one persona click', async ({ screen }) => {
    await screen.getByRole('button', 'Gift buyer').tap();
    await expect(screen.getByRole('heading', 'The gift that fills a room.', { level: 1 })).toBeVisible({ timeout: 10_000 });
  });

  test('bundle buyer sees the bundle hero and the upsell note', async ({ screen }) => {
    await screen.getByRole('button', 'Bundle buyer (3 in cart)').tap();
    await expect(screen.getByRole('heading', 'Three scents. One calm home.', { level: 1 })).toBeVisible({ timeout: 10_000 });
    await expect(screen.getByText('Bundle & save — your three, for $108. Save $24.')).toBeVisible();
  });

  test('switching persona shows the new persona, not the previous one', async ({ screen }) => {
    await screen.getByRole('button', 'Gift buyer').tap();
    await expect(screen.getByRole('heading', 'The gift that fills a room.', { level: 1 })).toBeVisible({ timeout: 10_000 });
    await screen.getByRole('button', 'Woody-scent browser').tap();
    // woody re-sorts the grid: Fig & Cedar, Black Pepper & Oak, Sandalwood first
    await expect(screen.getByRole('heading', { level: 3 }).first()).toHaveText('Fig & Cedar', { timeout: 10_000 });
    await expect(screen.getByRole('heading', { level: 3 }).nth(1)).toHaveText('Black Pepper & Oak', { timeout: 10_000 });
  });

  test('"New visitor (reset traits)" returns the default page', async ({ screen }) => {
    await screen.getByRole('button', 'Gift buyer').tap();
    await expect(screen.getByRole('heading', 'The gift that fills a room.', { level: 1 })).toBeVisible({ timeout: 10_000 });
    await screen.getByRole('button', 'New visitor (reset traits)').tap();
    await expect(screen.getByRole('heading', 'Light every moment.', { level: 1 })).toBeVisible({ timeout: 10_000 });
  });

  test('the demo store fits the viewport width (no sideways scroll)', async ({ browser }) => {
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
  });

  // The original step drove this through an agent model (GitHub Copilot). The
  // outcome is asserted directly so the gate does not depend on a subscription login.
  test('returning customer gets the subscribe-and-save offer', async ({ screen }) => {
    await screen.getByRole('button', 'Returning customer').tap();
    await expect(screen.getByText('Welcome back.', { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(screen.getByText('Subscribe & save 15%', { exact: false })).toBeVisible();
    await expect(screen.getByRole('button', 'Start subscription')).toBeVisible();
  });
});
