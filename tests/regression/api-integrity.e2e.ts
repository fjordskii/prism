// Regression tests for bugs found in the 2026-10-07 bug bash. Each failed on
// main before this PR's fix and passes after it. IDs are holdings-board PRISM-0NN items.
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN, DEMO_TOKEN } from '../support/env.ts';
import { api } from '../support/helpers.ts';

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

describe('regression: API', { tags: ['regression'] }, () => {
  test('PRISM-005 DSR erasure actually deletes the visitor', async ({ app }) => {
    const vid = uid('v_dsr');
    await api(app.baseUrl, '/api/identify', { method: 'POST', json: { visitorId: vid, site: 'demo', traits: { intent: 'gift' } } });
    const del = await api(app.baseUrl, `/api/visitors/${vid}?site=demo`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(del.body).toEqual({ ok: true, deleted: vid });
    const after = await api(app.baseUrl, `/api/visitors/${vid}?site=demo`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(after.body.visitor).toBeNull();
  });

  test('PRISM-002 the demo token cannot export or erase another tenant', async ({ app }) => {
    const exp = await api(app.baseUrl, `/api/export?site=some-customer`, { headers: { authorization: `Bearer ${DEMO_TOKEN}` } });
    expect(exp.status).toBe(401);
    const dsr = await api(app.baseUrl, `/api/visitors/anyone?site=some-customer`, { headers: { authorization: `Bearer ${DEMO_TOKEN}` } });
    expect(dsr.status).toBe(401);
    const erase = await api(app.baseUrl, `/api/visitors/anyone?site=some-customer`, { method: 'DELETE', headers: { authorization: `Bearer ${DEMO_TOKEN}` } });
    expect(erase.status).toBe(401);
    const plan = await api(app.baseUrl, `/api/sites/some-customer/plan`, { method: 'POST', headers: { authorization: `Bearer ${DEMO_TOKEN}` }, json: { plan: 'growth' } });
    expect(plan.status).toBe(401);
    // still allowed on the demo site
    expect((await api(app.baseUrl, `/api/export?site=demo`, { headers: { authorization: `Bearer ${DEMO_TOKEN}` } })).status).toBe(200);
  });

  test('PRISM-015 catalog reads need a token or session scoped to that site', async ({ app }) => {
    for (const path of ['/api/sites', '/api/variants?site=demo', '/api/stats?site=demo']) {
      expect((await api(app.baseUrl, path)).status).toBe(401);
    }
    expect((await api(app.baseUrl, '/api/variants?site=demo', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(200);
    expect((await api(app.baseUrl, '/api/stats?site=some-customer', { headers: { authorization: `Bearer ${DEMO_TOKEN}` } })).status).toBe(401);
    expect((await api(app.baseUrl, '/api/variants?site=some-customer', { headers: { authorization: `Bearer ${DEMO_TOKEN}` } })).status).toBe(401);
    expect((await api(app.baseUrl, '/api/stats?site=demo', { headers: { authorization: `Bearer ${DEMO_TOKEN}` } })).status).toBe(200);
    const sites = await api(app.baseUrl, '/api/sites', { headers: { authorization: `Bearer ${DEMO_TOKEN}` } });
    expect(sites.status).toBe(200);
    expect(sites.body).toEqual(['demo']);

    // Session path the test server supports: DEV_AUTH_EMAIL → /auth/dev-login.
    const login = await fetch(new URL('/auth/dev-login', app.baseUrl), { redirect: 'manual' });
    expect(login.status).toBe(302);
    const raw = login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? ''];
    const cookie = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    expect(cookie).toContain('prism_session=');
    const authed = await api(app.baseUrl, '/api/stats?site=demo', { headers: { cookie } });
    expect(authed.status).toBe(200);
    expect(authed.body.variants.length).toBeGreaterThanOrEqual(5);
  });

  test('PRISM-006 a control conversion needs a prior control impression', async ({ app }) => {
    const r = await api(app.baseUrl, '/api/events', { method: 'POST', json: { site: 'demo', visitorId: uid('v_ctl'), events: [{ variantId: null, selector: '#hero', type: 'conversion' }] } });
    expect(r.body.recorded).toBe(0);
  });

  test('PRISM-016 malformed JSON and unknown event types get a 400, not a 500 / silent insert', async ({ app }) => {
    for (const path of ['/api/decide', '/api/identify', '/api/events']) {
      const r = await api(app.baseUrl, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
      expect(r.status).toBe(400);
    }
    const bad = await api(app.baseUrl, '/api/events', { method: 'POST', json: { site: 'demo', visitorId: uid('v_t'), events: [{ variantId: null, selector: '#hero', type: 'purchase' }] } });
    expect(bad.body.recorded ?? 0).toBe(0);
  });

  test('PRISM-012 the SRI hash published on the landing page matches the served snippet', async ({ app }) => {
    const html = await (await fetch(new URL('/', app.baseUrl))).text();
    const published = html.match(/integrity="(sha384-[^"]+)"/)?.[1];
    const js = new Uint8Array(await (await fetch(new URL('/snippet.v1.js', app.baseUrl))).arrayBuffer());
    const digest = Buffer.from(await crypto.subtle.digest('SHA-384', js)).toString('base64');
    expect(published).toBe(`sha384-${digest}`);
  });
});
