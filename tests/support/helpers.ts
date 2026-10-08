import type { Browser } from '@e2e-dev/web';

/** Horizontal overflow in CSS px (0 = page fits the viewport width). */
export async function horizontalOverflow(browser: Browser): Promise<number> {
  return browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

export async function api(baseUrl: string | undefined, path: string, init?: RequestInit & { json?: unknown }) {
  const { json, ...rest } = init ?? {};
  const res = await fetch(new URL(path, baseUrl), {
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}
