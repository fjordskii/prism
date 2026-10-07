import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { ADMIN_TOKEN, DEMO_TOKEN } from './support/env.ts';
import { api } from './support/helpers.ts';

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

describe('runtime + admin API', { tags: ['api'] }, () => {
  test('decide: a gift visitor gets the gift hero; an unknown visitor gets nothing', async ({ app }) => {
    const vid = uid('v_api');
    expect((await api(app.baseUrl, '/api/identify', { method: 'POST', json: { visitorId: vid, site: 'demo', traits: { intent: 'gift' } } })).status).toBe(200);
    const d = await api(app.baseUrl, '/api/decide', { method: 'POST', json: { visitorId: vid, site: 'demo' } });
    expect(d.status).toBe(200);
    expect(d.body.decisions).toEqual([expect.objectContaining({ selector: '#hero', name: 'Gift-buyer hero' })]);
    const anon = await api(app.baseUrl, '/api/decide', { method: 'POST', json: { visitorId: uid('v_anon'), site: 'demo' } });
    expect(anon.body.decisions).toEqual([]);
  });

  test('events: a variant conversion needs a prior impression', async ({ app }) => {
    const vid = uid('v_ev');
    const variants = (await api(app.baseUrl, '/api/variants?site=demo')).body as { id: number; selector: string }[];
    const v = variants[0]!;
    const orphan = await api(app.baseUrl, '/api/events', { method: 'POST', json: { site: 'demo', visitorId: vid, events: [{ variantId: v.id, selector: v.selector, type: 'conversion' }] } });
    expect(orphan.body.recorded).toBe(0);
    const ok = await api(app.baseUrl, '/api/events', { method: 'POST', json: { site: 'demo', visitorId: vid, events: [
      { variantId: v.id, selector: v.selector, type: 'impression' }, { variantId: v.id, selector: v.selector, type: 'conversion' }] } });
    expect(ok.body.recorded).toBe(2);
  });

  test('stats: rates come with 95% CIs and a control arm', async ({ app }) => {
    const s = await api(app.baseUrl, '/api/stats?site=demo');
    expect(s.status).toBe(200);
    expect(s.body.variants.length).toBeGreaterThanOrEqual(5);
    const gift = s.body.variants.find((v: any) => v.name === 'Gift-buyer hero');
    expect(gift.ci95[0]).toBeLessThan(gift.rate);
    expect(gift.ci95[1]).toBeGreaterThan(gift.rate);
    expect(s.body.control.impressions).toBeGreaterThan(0);
  });

  test('variant writes: no token 401; demo token only on the demo site', async ({ app }) => {
    const body = { site: 'demo', name: uid('e2e'), selector: '#e2e-none', ops: '[]', audience: '[]' };
    expect((await api(app.baseUrl, '/api/variants', { method: 'POST', json: body })).status).toBe(401);
    const other = await api(app.baseUrl, '/api/variants', { method: 'POST', headers: { authorization: `Bearer ${DEMO_TOKEN}` }, json: { ...body, site: 'someone-else' } });
    expect(other.status).toBe(401);
    const mine = await api(app.baseUrl, '/api/variants', { method: 'POST', headers: { authorization: `Bearer ${DEMO_TOKEN}` }, json: body });
    expect(mine.status).toBe(201);
    const del = await api(app.baseUrl, `/api/variants/${mine.body.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(del.status).toBe(200);
  });

  test('snippet: served with cache headers; v1 is immutable', async ({ app }) => {
    const r = await fetch(new URL('/snippet.v1.js', app.baseUrl));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(await r.text()).toContain('window.prism');
  });
});
