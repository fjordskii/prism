import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN } from '../support/env.ts';

describe('regression: architecture', { tags: ['regression'] }, () => {
  test('architecture requires a token or session', async ({ app, screen }) => {
    await app.open('/architecture');
    await expect(screen.getByText('Unauthorized', { exact: false })).toBeVisible();
  });

  test('PRISM-013 mermaid diagrams render and none show a syntax error', async ({ app, browser }) => {
    await app.open(`/architecture?token=${ADMIN_TOKEN}`);
    await expect.poll(async () => browser.evaluate(() => {
      const blocks = [...document.querySelectorAll('.mermaid')];
      if (blocks.length < 3) return 'waiting for diagrams';
      const text = blocks.map((b) => b.textContent || '').join('\n');
      if (/syntax error/i.test(text)) return 'syntax error';
      const svgs = blocks.filter((b) => b.querySelector('svg')).length;
      return svgs === 3 ? 'ok' : `rendered ${svgs}`;
    }), { timeout: 30_000 }).toBe('ok');
  });
});
