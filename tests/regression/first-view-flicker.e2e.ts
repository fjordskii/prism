import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { api } from '../support/helpers.ts';

// Desktop and mobile both run this file (e2e.config.ts targets).
// A first view has traits on the server and an empty decision cache, which is
// the case that used to paint the default hero and then swap it.

type FlickerReport = {
  texts: string[];
  navVisible: boolean;
  at: { text: string; heroHidden: boolean; navHidden: boolean; rootHidden: boolean } | null;
  lastT: number;
};

async function report(browser: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<FlickerReport> {
  return browser.evaluate(() => {
    const log = (window as unknown as { __prismFlickerLog?: { t: number; text: string; visible: boolean; navVisible: boolean }[] }).__prismFlickerLog || [];
    const texts = [...new Set(log.filter((e) => e.visible && e.text).map((e) => e.text))];
    const navVisible = log.some((e) => e.navVisible);
    const at = (window as unknown as { __prismAtHero?: FlickerReport['at'] }).__prismAtHero ?? null;
    const lastT = log.length ? log[log.length - 1].t : 0;
    return { texts, navVisible, at, lastT };
  }) as Promise<FlickerReport>;
}

async function giftVisitor(app: { open: (path: string) => Promise<unknown>; baseUrl?: string }, browser: { evaluate: (fn: () => unknown) => Promise<unknown> }) {
  await app.open('/demo/?flicker=1');
  await expect.poll(() => browser.evaluate(() => typeof (window as unknown as { prism?: { visitorId?: string } }).prism?.visitorId)).toBe('string');
  await expect.poll(() => browser.evaluate(() => Object.keys(localStorage).some((k) => k.indexOf('_cache_') >= 0)), { timeout: 10_000 }).toBe(true);
  const vid = await browser.evaluate(() => (window as unknown as { prism: { visitorId: string } }).prism.visitorId);
  const identified = await api(app.baseUrl, '/api/identify', {
    method: 'POST',
    json: { visitorId: vid, site: 'demo', traits: { intent: 'gift' } },
  });
  expect(identified.status).toBe(200);
  await browser.evaluate(() => {
    localStorage.clear();
    try { localStorage.setItem = () => {}; } catch (e) { /* host object may be frozen; the clear is what matters */ }
  });
}

function expectHiddenDefault(at: FlickerReport['at']) {
  expect(at).toEqual({
    text: 'Light every moment.',
    heroHidden: true,
    navHidden: false,
    rootHidden: false,
  });
}

describe('PRISM-024 first-view flicker', { tags: ['regression'] }, () => {
  test('a first view never shows the default hero before the gift variant', async ({ app, browser }) => {
    await giftVisitor(app, browser);
    await app.open('/demo/?flicker=1');
    await expect.poll(async () => (await report(browser)).lastT, { timeout: 8_000 }).toBeGreaterThan(1000);
    const seen = await report(browser);
    expectHiddenDefault(seen.at);
    expect(seen.navVisible).toBe(true);
    expect(seen.texts).toEqual(['The gift that fills a room.']);
  });

  test('a slow decide reveals the default and does not swap when the response lands', async ({ app, browser }) => {
    await giftVisitor(app, browser);
    await app.open('/demo/?flicker=late');
    await expect.poll(async () => (await report(browser)).lastT, { timeout: 8_000 }).toBeGreaterThan(2500);
    const seen = await report(browser);
    expectHiddenDefault(seen.at);
    expect(seen.navVisible).toBe(true);
    expect(seen.texts).toEqual(['Light every moment.']);
  });

  test('a dead decide reveals the default and leaves it there', async ({ app, browser }) => {
    await giftVisitor(app, browser);
    await app.open('/demo/?flicker=down');
    await expect.poll(async () => (await report(browser)).lastT, { timeout: 8_000 }).toBeGreaterThan(1000);
    const seen = await report(browser);
    expectHiddenDefault(seen.at);
    expect(seen.navVisible).toBe(true);
    expect(seen.texts).toEqual(['Light every moment.']);
  });
});
