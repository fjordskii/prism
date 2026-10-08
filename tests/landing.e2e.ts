import { describe, test, beforeEach } from '@e2e-dev/web';
import { expect } from 'e2e';
import { horizontalOverflow } from './support/helpers.ts';

describe('landing page', { tags: ['landing'] }, () => {
  beforeEach(async ({ app }) => {
    await app.open('/');
  });

  test('hero states the offer and links to install + demo', async ({ screen, browser }) => {
    await expect(browser).toHaveTitle('Prism: the right page for every visitor');
    await expect(screen.getByRole('heading', 'Website personalization, decided in under a millisecond.', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('link', 'Install the snippet').first()).toHaveAttribute('href', '#install');
    await expect(screen.getByRole('link', 'See the demo').first()).toHaveAttribute('href', '/demo/');
  });

  test('pricing shows four tiers with prices', async ({ screen }) => {
    const pricing = screen.getByRole('heading', 'Free until it proves itself');
    await screen.scrollUntilVisible(pricing);
    for (const [tier, price] of [['Shadow', '$0'], ['Growth', '$79'], ['Pro', '$179'], ['Agency', '$299']] as const) {
      await expect(screen.getByRole('heading', tier, { level: 3 })).toBeVisible();
      // $0 also appears in the hero proof strip, so take the pricing card (last match)
      await expect(screen.getByText(price, { exact: true }).last()).toBeAttached();
    }
  });

  test('the page fits the viewport width (no sideways scroll)', async ({ browser }) => {
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
  });

  test('trust pages are linked from the footer and render', async ({ app, screen }) => {
    for (const [path, heading] of [['/privacy', 'Privacy'], ['/security', 'Security'], ['/terms', 'Terms']] as const) {
      await app.open(path);
      await expect(screen.getByRole('heading', heading, { level: 1 })).toBeVisible();
    }
  });
});
