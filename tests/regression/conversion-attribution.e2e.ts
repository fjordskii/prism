import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';
import { api } from '../support/helpers.ts';

describe('regression: snippet attribution', { tags: ['regression'] }, () => {
  test('PRISM-006 clicking the returning-customer subscribe CTA never books a control conversion', async ({ app, screen, browser }) => {
    await app.open('/demo/');
    await expect.poll(() => browser.evaluate(() => typeof (window as any).prism?.identify)).toBe('function');
    // set traits through the public API, then reload so the variant applies
    await browser.evaluate(() => (window as any).prism.identify({ orders: 2, lastOrderDays: 32 }));
    await browser.reload();
    await browser.reload(); // second load: guarantees fresh decisions regardless of cache state
    await screen.getByRole('button', 'Start subscription').tap();
    const vid = await browser.evaluate(() => (window as any).prism.visitorId as string);
    await expect.poll(async () => {
      const r = await api(app.baseUrl, `/api/visitors/${vid}?site=demo`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      return (r.body.events as any[]).filter((e) => e.type === 'conversion').length;
    }, { timeout: 8_000 }).toBeGreaterThan(0);
    const r = await api(app.baseUrl, `/api/visitors/${vid}?site=demo`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    const controlConversions = (r.body.events as any[]).filter((e) => e.type === 'conversion' && e.variant_id === null);
    expect(controlConversions).toHaveLength(0);
  });
});
