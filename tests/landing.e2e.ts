import { describe, test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';
import { horizontalOverflow } from './support/helpers.ts';

describe('landing page', { tags: ['landing'] }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/');
  });

  test('hero states the offer and links to pilot + demo', async ({ screen, browser }) => {
    await expect(browser).toHaveTitle('Prism: personalization with a control group');
    await expect(screen.getByRole('heading', 'Personalization with a control group built in.', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('link', 'Book a pilot').first()).toHaveAttribute('href', '/pilot');
    await expect(screen.getByRole('link', 'See the demo').first()).toHaveAttribute('href', '/demo/');
  });

  test('pricing shows Discovery, Pilot, and Retain', async ({ screen }) => {
    const pricing = screen.getByRole('heading', 'Start with a pilot');
    await screen.scrollUntilVisible(pricing);
    await expect(screen.getByRole('heading', 'Discovery', { level: 3 })).toBeVisible();
    await expect(screen.getByRole('heading', 'Pilot', { level: 3 })).toBeVisible();
    await expect(screen.getByRole('heading', 'Retain', { level: 3 })).toBeVisible();
    await expect(screen.getByText('Free for the first 5 stores.')).toBeVisible();
    await expect(screen.getByText('$750 flat for 30 days.')).toBeVisible();
    await expect(screen.getByText('Ongoing management is $299/mo, month to month.')).toBeVisible();
  });

  test('the page fits the viewport width (no sideways scroll)', async ({ browser }) => {
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
  });

  test('trust pages are linked from the footer and render', async ({ app, screen, browser }) => {
    for (const [path, heading] of [['/privacy', 'Privacy'], ['/security', 'Security'], ['/terms', 'Terms']] as const) {
      await app.open(path);
      await expect(screen.getByRole('heading', heading, { level: 1 })).toBeVisible();
    }
    await app.open('/terms');
    await expect(screen.getByRole('heading', 'Service and Billing', { level: 2 })).toBeVisible();
    await expect(screen.getByRole('heading', 'Availability', { level: 2 })).toBeVisible();
    const terms = await browser.evaluate(() => document.body.textContent ?? '');
    expect(terms).toContain("don't offer an uptime guarantee or service credits during the pilot");
    expect(terms).toContain('The snippet fails open');
    expect(terms).not.toContain('99.9%');
    expect(terms).not.toContain('$79');
    expect(terms).not.toContain('$179');
  });
});
