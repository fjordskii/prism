import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';
import { api, horizontalOverflow } from '../support/helpers.ts';

describe('regression: pricing CTAs', { tags: ['regression'] }, () => {
  test('PRISM-032 every pricing card link is a public page', async ({ app, browser, screen }) => {
    await app.open('/');
    await screen.scrollUntilVisible(screen.getByRole('heading', 'Free until it proves itself'));
    const links = await browser.evaluate(() =>
      [...document.querySelectorAll('#pricing .tier a')].map((a) => ({
        href: a.getAttribute('href') ?? '',
        text: (a.textContent ?? '').trim(),
      })),
    );
    expect(links).toEqual([
      { href: '/pilot', text: 'Book a pilot' },
      { href: '/pilot', text: 'Book a pilot' },
      { href: '/pilot', text: 'Book a pilot' },
      { href: 'mailto:hello@sundaymorning.software', text: 'Talk to us' },
    ]);

    for (const link of links) {
      if (link.href.startsWith('mailto:')) continue;
      const res = await fetch(new URL(link.href, app.baseUrl), { redirect: 'manual' });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(new URL(res.url).pathname).toBe('/pilot');
      expect(body).toContain('Try Prism on your Shopify store');
      expect(body).not.toContain('Sign in to Prism');
      expect(body).not.toContain('Unauthorized');
    }

    const dashboard = await browser.evaluate(() => {
      const a = [...document.querySelectorAll('footer a')].find((el) => el.textContent?.trim() === 'Dashboard');
      return a?.getAttribute('href') ?? '';
    });
    expect(dashboard).toBe('/admin');
  });

  test('PRISM-032 Book a pilot submits and the admin token can read the inquiry', async ({ app, browser, screen }) => {
    await app.open('/');
    await screen.scrollUntilVisible(screen.getByRole('heading', 'Free until it proves itself'));
    for (const nth of [0, 1, 2]) {
      await app.open('/');
      await screen.scrollUntilVisible(screen.getByRole('heading', 'Free until it proves itself'));
      await screen.getByRole('link', 'Book a pilot').nth(nth).tap();
      await expect(screen.getByRole('heading', 'Try Prism on your Shopify store', { level: 1 })).toBeVisible();
      expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
    }

    const email = `buyer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    await screen.getByLabel('Email').fill(email);
    await screen.getByLabel('Store URL').fill('https://shop.example');
    await screen.getByLabel('Monthly visitors').fill('12000');
    await screen.getByLabel('Note').fill('First-time visitors and repeat buyers');
    await expect(screen.getByText('Prefer email? Write to', { exact: false })).toBeVisible();
    await screen.getByRole('button', 'Send').tap();
    await expect(screen.getByText("Thanks. We'll reply by email.")).toBeVisible();

    const open = await api(app.baseUrl, '/api/pilot/inquiries');
    expect(open.status).toBe(401);
    const listed = await api(app.baseUrl, '/api/pilot/inquiries', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(listed.status).toBe(200);
    expect(listed.body.inquiries).toEqual(expect.arrayContaining([
      expect.objectContaining({ email, storeUrl: 'https://shop.example', monthlyVisitors: '12000', note: 'First-time visitors and repeat buyers' }),
    ]));
  });
});
