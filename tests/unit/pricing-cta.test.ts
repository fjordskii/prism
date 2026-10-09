// PRISM-032: every pricing card link on / is a public page.
// Reads the served HTML, then follows redirects with no auth.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-pricing-")), "prism.db");
process.env.ADMIN_TOKEN = "unit-admin-token";
process.env.DEMO_TOKEN = "unit-demo-token";
process.env.HOLDOUT_PCT = "0";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.DEV_AUTH_EMAIL;

let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
beforeAll(async () => {
  ({ default: app } = await import("../../src/server.ts"));
});

function pricingCardHrefs(html: string): string[] {
  const section = html.match(/<section id="pricing"[\s\S]*?<\/section>/);
  if (!section) throw new Error("pricing section missing from /");
  return [...section[0].matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]!);
}

async function follow(href: string) {
  let path = href;
  for (let hop = 0; hop < 6; hop++) {
    const res = await app.request("http://127.0.0.1" + path, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, path, body: await res.text() };
      const next = new URL(loc, "http://127.0.0.1");
      path = next.pathname + next.search;
      continue;
    }
    return { status: res.status, path, body: await res.text() };
  }
  throw new Error("too many redirects from " + href);
}

test("pricing card links return 200 with no auth and never land on /admin or /auth/login", async () => {
  const html = await (await app.request("http://127.0.0.1/")).text();
  const hrefs = pricingCardHrefs(html);
  expect(hrefs).toEqual([
    "/pilot",
    "/pilot",
    "/pilot",
    "mailto:hello@sundaymorning.software",
  ]);

  for (const href of hrefs) {
    if (href.startsWith("mailto:")) continue;
    const final = await follow(href);
    expect(final.status).toBe(200);
    expect(final.path).toBe("/pilot");
    expect(final.path).not.toBe("/admin");
    expect(final.path).not.toBe("/auth/login");
    expect(final.body).toContain("Try Prism on your Shopify store");
    expect(final.body).not.toContain("Sign in to Prism");
    expect(final.body).not.toContain("Unauthorized");
  }

  const footer = html.slice(html.lastIndexOf("<footer"));
  expect(footer).toContain(">Dashboard</a>");
  expect(footer).toContain('href="/admin"');
});
