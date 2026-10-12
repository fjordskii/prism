import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';
import { api } from '../support/helpers.ts';

function campaigns(body: { days?: { events?: Record<string, { utm?: { campaign?: string }[] }> }[] }, campaign: string): string[] {
  const found: string[] = [];
  for (const day of body.days ?? []) {
    for (const [event, info] of Object.entries(day.events ?? {})) {
      if ((info.utm ?? []).some((row) => row.campaign === campaign)) found.push(event);
    }
  }
  return found.sort();
}

describe('regression: growth counts', { tags: ['regression'] }, () => {
  test('PRISM-028 a landing view and a pilot CTA click are counted, and the read is 401 without auth', async ({ app, screen }) => {
    const open = await api(app.baseUrl, '/api/growth');
    expect(open.status).toBe(401);
    expect(open.body).toEqual({ error: 'unauthorized' });

    const campaign = `prism028_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await app.open(`/?utm_source=e2e&utm_medium=test&utm_campaign=${campaign}`);
    await screen.scrollUntilVisible(screen.getByRole('heading', 'Start with a pilot'));
    await screen.getByRole('link', 'Book a pilot').last().tap();
    await expect(screen.getByRole('heading', 'Try Prism on your Shopify store', { level: 1 })).toBeVisible();

    const today = new Date().toISOString().slice(0, 10);
    await expect.poll(async () => {
      const listed = await api(app.baseUrl, `/api/growth?from=${today}&to=${today}`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (listed.status !== 200) return `status ${listed.status}`;
      return campaigns(listed.body, campaign).join(',');
    }, { timeout: 15_000 }).toBe('landing_view,pilot_cta,pilot_view');

    const listed = await api(app.baseUrl, `/api/growth?from=${today}&to=${today}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(listed.status).toBe(200);
    const day = listed.body.days.find((row: { day: string }) => row.day === today);
    const view = day.events.landing_view.utm.find((row: { campaign: string }) => row.campaign === campaign);
    const click = day.events.pilot_cta.utm.find((row: { campaign: string }) => row.campaign === campaign);
    expect(view).toEqual(expect.objectContaining({ source: 'e2e', medium: 'test', campaign, count: 1 }));
    expect(click).toEqual(expect.objectContaining({ source: 'e2e', medium: 'test', campaign, count: 1 }));
  });

  test('PRISM-036 every Book a pilot link carries landing UTM onto the stored inquiry', async ({ app, browser, screen }) => {
    const campaign = `prism036_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await app.open(`/?utm_source=e2e&utm_medium=test&utm_campaign=${campaign}`);
    const hrefs = await browser.evaluate(() =>
      [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((href) =>
        href === '/pilot' || href.startsWith('/pilot?') || href.startsWith('/pilot#'),
      ),
    );
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      expect(href.startsWith('/pilot?')).toBe(true);
      expect(href).toContain('utm_source=e2e');
      expect(href).toContain('utm_medium=test');
      expect(href).toContain(`utm_campaign=${campaign}`);
    }
    const heroHref = await browser.evaluate(() =>
      document.querySelector('.hero a.btn.solid')?.getAttribute('href') ?? '',
    );
    expect(heroHref).toContain(`utm_campaign=${campaign}`);

    await screen.getByRole('link', 'Book a pilot').first().tap();
    await expect(screen.getByRole('heading', 'Try Prism on your Shopify store', { level: 1 })).toBeVisible();
    const pilotUrl = await browser.evaluate(() => location.pathname + location.search);
    expect(pilotUrl).toContain('/pilot?');
    expect(pilotUrl).toContain('utm_source=e2e');
    expect(pilotUrl).toContain('utm_medium=test');
    expect(pilotUrl).toContain(`utm_campaign=${campaign}`);

    const email = `buyer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    await screen.getByLabel('Email').fill(email);
    await screen.getByLabel('Store URL').fill('https://shop.example');
    await screen.getByLabel('Monthly visitors').fill('12000');
    await screen.getByLabel('Note').fill('First-time visitors and repeat buyers');
    await screen.getByRole('button', 'Send').tap();
    await expect(screen.getByText("Thanks. We'll reply by email.")).toBeVisible();

    expect(await browser.cookies()).toEqual([]);

    const listed = await api(app.baseUrl, '/api/pilot/inquiries', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(listed.status).toBe(200);
    expect(listed.body.inquiries).toEqual(expect.arrayContaining([
      expect.objectContaining({ email, storeUrl: 'https://shop.example' }),
    ]));

    const today = new Date().toISOString().slice(0, 10);
    await expect.poll(async () => {
      const growth = await api(app.baseUrl, `/api/growth?from=${today}&to=${today}`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (growth.status !== 200) return `status ${growth.status}`;
      return campaigns(growth.body, campaign).join(',');
    }, { timeout: 15_000 }).toContain('pilot_inquiry');

    const growth = await api(app.baseUrl, `/api/growth?from=${today}&to=${today}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(growth.status).toBe(200);
    const day = growth.body.days.find((row: { day: string }) => row.day === today);
    const inquiry = day.events.pilot_inquiry.utm.find((row: { campaign: string }) => row.campaign === campaign);
    expect(inquiry).toEqual(expect.objectContaining({ source: 'e2e', medium: 'test', campaign, count: 1 }));
  });
});
