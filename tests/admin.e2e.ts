import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from './support/env.ts';
import { api } from './support/helpers.ts';

describe('admin dashboard', { tags: ['admin'] }, () => {
  test('is locked without a token', async ({ app, screen }) => {
    await app.open('/admin');
    await expect(screen.getByText('Unauthorized', { exact: false })).toBeVisible();
  });

  test('shows seeded variants with stats and the holdout row', async ({ app, screen }) => {
    await app.open(`/admin?token=${ADMIN_TOKEN}`);
    await expect(screen.getByRole('heading', 'Prism: personalization admin', { level: 1 })).toBeVisible();
    await expect(screen.getByRole('cell', 'Gift-buyer hero')).toBeVisible();
    await expect(screen.getByRole('cell', 'intent = "gift"')).toBeVisible();
  });

  test('owner creates a variant from a template', async ({ app, screen }) => {
    const site = `e2e-admin-${Date.now()}`;
    await app.open(`/admin?token=${ADMIN_TOKEN}&site=${site}`);
    await screen.getByText('Gift-buyer hero', { exact: true }).tap(); // template chip
    await expect(screen.getByPlaceholder('Gift-buyer hero')).toHaveValue('Gift-buyer hero');
    await screen.getByRole('button', 'Create variant').tap();
    await expect(screen.getByText('Created ✓')).toBeVisible();
    await expect(screen.getByRole('cell', 'Gift-buyer hero')).toBeVisible();
  });

  test('owner pauses a variant', async ({ app, screen }) => {
    const site = `e2e-pause-${Date.now()}`;
    const created = await api(app.baseUrl, '/api/variants', {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      json: { site, name: 'Pause me', selector: '#e2e-none', ops: '[]', audience: '[]' },
    });
    expect(created.status).toBe(201);
    await app.open(`/admin?token=${ADMIN_TOKEN}&site=${site}`);
    await expect(screen.getByText('active', { exact: true })).toBeVisible();
    await screen.getByRole('button', 'Pause').tap();
    await expect(screen.getByText('paused', { exact: true })).toBeVisible();
    const after = await api(app.baseUrl, `/api/variants?site=${site}`);
    expect(after.body[0].active).toBe(0);
  });
});
