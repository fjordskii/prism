import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Unfixed: needs a signup + billing product decision (holdings-board PRISM-003).
describe('bug repros: buying path', { tags: ['bugbash'] }, () => {
  test('PRISM-003 "Start free" leads a prospect to a way to sign up, not a locked dashboard', async ({ app, screen }) => {
    await app.open('/');
    const href = await screen.getByRole('link', 'Start free').getAttribute('href');
    await app.open(href ?? '/');
    await expect(screen.getByText('Unauthorized', { exact: false })).toBeHidden();
  });
});
