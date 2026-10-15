import type { Browser } from '@e2e-dev/web';
import { ADMIN_TOKEN } from './env.ts';

/** Horizontal overflow in CSS px (0 = page fits the viewport width). */
export async function horizontalOverflow(browser: Browser): Promise<number> {
  return browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

export async function api(baseUrl: string | undefined, path: string, init?: RequestInit & { json?: unknown }) {
  const { json, ...rest } = init ?? {};
  const headers: Record<string, string> = {
    ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(rest.headers as Record<string, string> | undefined),
  };
  const route = path.split('?')[0];
  const ingest = rest.method === 'POST' && (route === '/api/identify' || route === '/api/events');
  if (ingest && json && typeof json === 'object' && json !== null && 'site' in json && !('x-prism-key' in headers)) {
    headers['x-prism-key'] = await writeKey(baseUrl, String((json as { site: unknown }).site));
  }
  const res = await fetch(new URL(path, baseUrl), {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

export async function writeKey(baseUrl: string | undefined, site: string, token = ADMIN_TOKEN): Promise<string> {
  const r = await api(baseUrl, '/api/sites/' + encodeURIComponent(site) + '/write-key', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status !== 200 || typeof r.body?.writeKey !== 'string') {
    throw new Error('write-key ' + site + ' ' + r.status);
  }
  return r.body.writeKey;
}

export function keyHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-prism-key': key, ...extra };
}
