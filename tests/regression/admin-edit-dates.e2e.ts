import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';
import { api } from '../support/helpers.ts';

describe('regression: admin', { tags: ['regression'] }, () => {
  test('PRISM-011 Edit pre-fills the schedule in local time (no timezone shift)', async ({ app, screen, browser }) => {
    const site = `e2e-dates-${Date.now()}`;
    // 2030-01-15 09:30 in the browser's local zone, computed in the page
    await app.open('/privacy');
    const startsAt = await browser.evaluate(() => new Date(2030, 0, 15, 9, 30).getTime());
    const offset = await browser.evaluate(() => new Date(2030, 0, 15, 9, 30).getTimezoneOffset());
    test.skip(offset === 0, 'browser runs in UTC; the shift only shows in non-UTC zones');
    const r = await api(app.baseUrl, '/api/variants', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      json: { site, name: 'Scheduled', selector: '#e2e-none', ops: '[]', audience: '[]', starts_at: startsAt } });
    expect(r.status).toBe(201);
    await app.open(`/admin?token=${ADMIN_TOKEN}&site=${site}`);
    await screen.getByRole('button', 'Edit').tap();
    await expect(browser.locator('#b-starts')).toHaveValue('2030-01-15T09:30');
  });
});
