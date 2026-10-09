// PRISM-032: public pilot inquiries. Validation, honeypot, rate limit, and the owner-only read.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "unit-admin-token";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-pilot-")), "prism.db");
process.env.ADMIN_TOKEN = ADMIN;
process.env.DEMO_TOKEN = "unit-demo-token";
process.env.READONLY_TOKENS = "unit-readonly-token";
process.env.HOLDOUT_PCT = "0";
process.env.PILOT_INQUIRY_LIMIT = "2";
process.env.GOOGLE_ALLOWED_EMAILS = "owner@prism.test:owner,editor@prism.test,viewer@prism.test:viewer";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.DEV_AUTH_EMAIL;

let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
let db: import("bun:sqlite").Database;
let makeSession: (email: string) => Promise<string>;

beforeAll(async () => {
  ({ db } = await import("../../src/db.ts"));
  ({ default: app } = await import("../../src/server.ts"));
  ({ makeSession } = await import("../../src/auth.ts"));
});

const count = () => (db.prepare("SELECT COUNT(*) AS n FROM pilot_inquiries").get() as { n: number }).n;

function post(body: unknown, ip: string, extra: Record<string, string> = {}) {
  return app.request("http://127.0.0.1/api/pilot/inquiry", {
    method: "POST",
    headers: { "content-type": "application/json", "fly-client-ip": ip, ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { email: "buyer@shop.example", storeUrl: "https://shop.example", monthlyVisitors: "about 12k", note: "repeat buyers" };

test("GET /pilot is public and shows the offer, the form, and the mailto fallback", async () => {
  const res = await app.request("http://127.0.0.1/pilot");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Try Prism on your Shopify store");
  expect(html).toContain("Tell us about your store and we'll reply with next steps.");
  expect(html).toContain(">Send<");
  expect(html).toContain("Prefer email? Write to");
  expect(html).toContain("mailto:hello@sundaymorning.software?subject=Prism%20pilot");
  expect(html).not.toContain("Sign in to Prism");
  expect(html).not.toContain("$79");
});

test("a valid inquiry stores one row", async () => {
  const before = count();
  const res = await post({ ...valid, email: "one@shop.example" }, "203.0.113.10");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(count()).toBe(before + 1);
  const row = db.prepare("SELECT email, store_url, monthly_visitors, note FROM pilot_inquiries WHERE email = ?").get("one@shop.example");
  expect(row).toEqual({
    email: "one@shop.example",
    store_url: "https://shop.example",
    monthly_visitors: "about 12k",
    note: "repeat buyers",
  });
});

test("a form post shows the thank-you state and stores the row", async () => {
  const before = count();
  const res = await app.request("http://127.0.0.1/api/pilot/inquiry", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "fly-client-ip": "203.0.113.11" },
    body: new URLSearchParams({ email: "form@shop.example", storeUrl: "https://form.example", note: "from the form" }).toString(),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Thanks. We'll reply by email.");
  expect(count()).toBe(before + 1);
});

test("an invalid email, a missing store URL, a bad URL, or an oversized field stores nothing", async () => {
  const before = count();
  const cases = [
    { email: "not-an-email", storeUrl: "https://shop.example" },
    { email: "buyer@shop.example", storeUrl: "" },
    { email: "buyer@shop.example" },
    { email: "buyer@shop.example", storeUrl: "javascript:alert(1)" },
    { email: "buyer@shop.example", storeUrl: "not a url" },
    { email: "a".repeat(10_000) + "@shop.example", storeUrl: "https://shop.example" },
    { email: "buyer@shop.example", storeUrl: "https://shop.example/" + "x".repeat(10_000) },
    { email: "buyer@shop.example", storeUrl: "https://shop.example", note: "n".repeat(10_000) },
    { email: "buyer@shop.example", storeUrl: "ftp://shop.example" },
  ];
  for (const [i, body] of cases.entries()) {
    const res = await post(body, `203.0.113.${100 + i}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
  }
  const html = await app.request("http://127.0.0.1/api/pilot/inquiry", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "fly-client-ip": "203.0.113.21" },
    body: new URLSearchParams({ email: "not-an-email", storeUrl: "" }).toString(),
  });
  expect(html.status).toBe(400);
  expect(await html.text()).toContain("That didn't go through. Please check your email and store URL, or email us instead.");
  expect(count()).toBe(before);
});

test("a filled honeypot stores nothing", async () => {
  const before = count();
  const res = await post({ ...valid, email: "bot@shop.example", company: "Acme Spam" }, "203.0.113.30");
  expect(res.status).toBe(400);
  expect(count()).toBe(before);
  const blank = await post({ ...valid, email: "human@shop.example", company: "   " }, "203.0.113.31");
  expect(blank.status).toBe(200);
  expect(count()).toBe(before + 1);
});

test("the per-IP rate limit stores nothing past the cap and returns 429", async () => {
  const before = count();
  const ip = "203.0.113.40";
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const res = await post({ ...valid, email: `rate${i}@shop.example` }, ip);
    statuses.push(res.status);
  }
  expect(statuses).toEqual([200, 200, 429]);
  expect(count()).toBe(before + 2);
  const other = await post({ ...valid, email: "other@shop.example" }, "203.0.113.41");
  expect(other.status).toBe(200);
  const form = await app.request("http://127.0.0.1/api/pilot/inquiry", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "fly-client-ip": ip },
    body: new URLSearchParams({ email: "late@shop.example", storeUrl: "https://shop.example" }).toString(),
  });
  expect(form.status).toBe(429);
  expect(await form.text()).toContain("That didn't go through. Please check your email and store URL, or email us instead.");
});

test("GET /api/pilot/inquiries is 401 without auth and lists rows for the admin token or an owner session", async () => {
  const open = await app.request("http://127.0.0.1/api/pilot/inquiries");
  expect(open.status).toBe(401);

  const demo = await app.request("http://127.0.0.1/api/pilot/inquiries", { headers: { authorization: "Bearer unit-demo-token" } });
  expect(demo.status).toBe(401);
  const readonly = await app.request("http://127.0.0.1/api/pilot/inquiries", { headers: { authorization: "Bearer unit-readonly-token" } });
  expect(readonly.status).toBe(401);

  const editor = await app.request("http://127.0.0.1/api/pilot/inquiries", {
    headers: { cookie: `prism_session=${await makeSession("editor@prism.test")}` },
  });
  expect(editor.status).toBe(401);
  const viewer = await app.request("http://127.0.0.1/api/pilot/inquiries", {
    headers: { cookie: `prism_session=${await makeSession("viewer@prism.test")}` },
  });
  expect(viewer.status).toBe(401);

  const admin = await app.request("http://127.0.0.1/api/pilot/inquiries", { headers: { authorization: `Bearer ${ADMIN}` } });
  expect(admin.status).toBe(200);
  const adminBody = await admin.json();
  expect(adminBody.inquiries.some((row: { email: string }) => row.email === "one@shop.example")).toBe(true);

  const owner = await app.request("http://127.0.0.1/api/pilot/inquiries", {
    headers: { cookie: `prism_session=${await makeSession("owner@prism.test")}` },
  });
  expect(owner.status).toBe(200);
  const ownerBody = await owner.json();
  expect(ownerBody.inquiries.length).toBe(adminBody.inquiries.length);
  expect(ownerBody.inquiries[0]).toEqual(expect.objectContaining({
    email: expect.any(String),
    storeUrl: expect.any(String),
    createdAt: expect.any(Number),
  }));
});
