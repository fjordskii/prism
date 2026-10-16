import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN, DEMO_TOKEN } from '../support/env.ts';
import { horizontalOverflow } from '../support/helpers.ts';

describe('regression: admin write key', { tags: ['regression'] }, () => {
  test('PRISM-041 a non-owner does not see the write key row', async ({ app, screen, browser }) => {
    await app.open('/privacy');
    const pending = browser.waitForResponse(/\/api\/sites\/demo\/write-key/);
    await app.open(`/admin?token=${DEMO_TOKEN}&site=demo`);
    expect((await pending).status).toBe(403);
    await expect(screen.getByText('personalization admin')).toBeVisible();
    await expect(browser.locator('#writeKeyBox')).toBeHidden();
    await expect(screen.getByRole('button', 'Copy key')).toBeHidden();
    await expect(screen.getByRole('button', 'Copy snippet')).toBeHidden();
    await expect(screen.getByRole('button', 'Rotate')).toBeHidden();
    expect(await browser.locator('#writeKeyValue').inputValue()).toBe('');
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
  });

  test('PRISM-041 the owner can read the write key, including on a phone', async ({ app, screen, browser }) => {
    await app.open('/privacy');
    const pending = browser.waitForResponse(/\/api\/sites\/demo\/write-key/);
    await app.open(`/admin?token=${ADMIN_TOKEN}&site=demo`);
    expect((await pending).status).toBe(200);
    await expect(screen.getByRole('button', 'Copy key')).toBeVisible();
    await expect(screen.getByRole('button', 'Rotate')).toBeVisible();
    const fit = await browser.evaluate(() => {
      const input = document.getElementById('writeKeyValue') as HTMLInputElement | null;
      if (!input) return null;
      return { value: input.value, clientWidth: input.clientWidth, scrollWidth: input.scrollWidth };
    });
    expect(fit?.value.startsWith('wk_')).toBe(true);
    expect((fit?.value.length ?? 0) >= 35).toBe(true);
    expect((fit?.clientWidth ?? 0) > 200).toBe(true);
    expect((fit?.scrollWidth ?? 1) <= (fit?.clientWidth ?? 0) + 1).toBe(true);
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
  });
});
