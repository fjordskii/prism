import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from './support/env.ts';
import { api } from './support/helpers.ts';

// Persona pick, impression, conversion, then the dashboard listing that variant.
describe('core loop', { tags: ['core'] }, () => {
  test('gift buyer impression and conversion show up in stats, and admin lists the variant', async ({ app, screen }) => {
    const stats = async () =>
      (await api(app.baseUrl, '/api/stats?site=demo', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).body;
    const gift = (body: { variants: { name: string; impressions: number; conversions: number }[] }) =>
      body.variants.find((v) => v.name === 'Gift-buyer hero')!;

    await app.open('/demo/');
    await expect(screen.getByRole('heading', 'Light every moment.', { level: 1 })).toBeVisible();
    const before = gift(await stats());

    await screen.getByRole('button', 'Gift buyer').tap();
    await expect(screen.getByRole('heading', 'The gift that fills a room.', { level: 1 })).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => gift(await stats()).impressions, { timeout: 10_000 }).toBeGreaterThan(before.impressions);

    const shown = gift(await stats());
    await screen.getByRole('link', 'Shop gift sets').tap();
    await expect.poll(async () => gift(await stats()).conversions, { timeout: 10_000 }).toBeGreaterThan(shown.conversions);

    await app.open(`/admin?token=${ADMIN_TOKEN}`);
    await expect(screen.getByRole('cell', 'Gift-buyer hero')).toBeVisible();
  });
});
