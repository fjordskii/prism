import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';
import { api, horizontalOverflow } from '../support/helpers.ts';

const TEST_LINK = 'https://buy.stripe.com/test_e2e_mock';

describe('regression: pilot billing', { tags: ['regression'] }, () => {
  test('PRISM-018 off mode shows the offers and no pay button', async ({ app, browser, screen }) => {
    await app.open('/pilot');
    await expect(screen.getByRole('heading', 'Discovery', { level: 3 })).toBeVisible();
    await expect(screen.getByRole('heading', 'Pilot', { level: 3 })).toBeVisible();
    await expect(screen.getByRole('heading', 'Retain', { level: 3 })).toBeVisible();
    await expect(screen.getByText('Free for the first 5 stores.')).toBeVisible();
    await expect(screen.getByText('$750 flat for 30 days.')).toBeVisible();
    await expect(screen.getByText('Full refund if setup or the day 30 report is not delivered.')).toBeVisible();
    await expect(screen.getByText('There is no lift guarantee.')).toBeVisible();
    await expect(screen.getByText('Orders and revenue are tracked.')).toBeVisible();
    await expect(screen.getByText('Ongoing management is $299/mo, month to month.')).toBeVisible();
    await expect(screen.getByRole('button', 'Send')).toBeVisible();
    expect(await browser.evaluate(() => document.body.textContent?.includes('Pay for the pilot') ?? false)).toBe(false);
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);

    await app.open('/');
    await screen.scrollUntilVisible(screen.getByText('Free for the first 5 stores.'));
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
    expect(await browser.evaluate(() => document.body.textContent?.includes('Pay for the pilot') ?? false)).toBe(false);

    const open = await api(app.baseUrl, '/api/pilot/billing-status');
    expect(open.status).toBe(401);
    const status = await api(app.baseUrl, '/api/pilot/billing-status', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ mode: 'off', effectiveMode: 'off', priceShown: false });
  });

  test('PRISM-018 test mode shows the pay button to an owner only', async () => {
    const server = await startTestServer();
    try {
      const anon = await (await fetch(new URL('/pilot', server.url))).text();
      expect(anon).toContain('$750 flat for 30 days.');
      expect(anon).not.toContain('Pay for the pilot');
      expect(anon).not.toContain(TEST_LINK);

      const login = await fetch(new URL('/auth/dev-login', server.url), { redirect: 'manual' });
      expect(login.status).toBe(302);
      const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
      expect(cookie).toContain('prism_session=');

      const owner = await (await fetch(new URL('/pilot', server.url), { headers: { cookie } })).text();
      expect(owner).toContain(`href="${TEST_LINK}"`);
      expect(owner).toContain('Pay for the pilot');

      const home = await (await fetch(new URL('/', server.url), { headers: { cookie } })).text();
      expect(home).toContain(`href="${TEST_LINK}"`);
      const homeAnon = await (await fetch(new URL('/', server.url))).text();
      expect(homeAnon).not.toContain('Pay for the pilot');

      const status = await fetch(new URL('/api/pilot/billing-status', server.url), { headers: { cookie } });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ mode: 'test', effectiveMode: 'test', priceShown: true });
      const locked = await fetch(new URL('/api/pilot/billing-status', server.url));
      expect(locked.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close(() => resolve(port));
    });
  });
}

async function startTestServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn('bun', ['tests/support/serve.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TOKEN: 'e2e-billing-admin',
      DEMO_TOKEN: 'e2e-billing-demo',
      HOLDOUT_PCT: '0',
      PRISM_PLAN: 'selfhost',
      DEV_AUTH_EMAIL: 'e2e-owner@prism.test',
      BILLING_MODE: 'test',
      PILOT_PAYMENT_LINK: TEST_LINK,
      BILLING_LIVE_APPROVED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (chunk) => { log += String(chunk); });
  child.stderr?.on('data', (chunk) => { log += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error(`billing server exited\n${log}`);
    try {
      const res = await fetch(url + '/snippet.js');
      if (res.ok) {
        return {
          url,
          stop: () => new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2_000);
          }),
        };
      }
    } catch {
      // the port is not open yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill('SIGKILL');
  throw new Error(`billing server did not start\n${log}`);
}
