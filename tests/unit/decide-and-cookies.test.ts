// Unit tests for the /api/decide hardening and auth cookie flags (PRISM-030/031).
// Runs the Hono app in-process against a throwaway DB: `bun test tests/unit`.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "unit-admin-token";
const DEMO = "unit-demo-token";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-unit-")), "prism.db");
process.env.ADMIN_TOKEN = ADMIN;
process.env.DEMO_TOKEN = DEMO;
process.env.HOLDOUT_PCT = "0";
process.env.PRISM_PLAN = "selfhost";
// Fake OAuth client so /auth/google sets the state cookie (no network is touched).
process.env.GOOGLE_CLIENT_ID = "unit-client-id";
process.env.GOOGLE_CLIENT_SECRET = "unit-client-secret";
process.env.DECIDE_RATE_PER_MIN = "20";
process.env.DECIDE_NEW_VISITORS_PER_HOUR = "5";

let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
let db: import("bun:sqlite").Database;
beforeAll(async () => {
  await import("../../src/seed.ts");
  ({ db } = await import("../../src/db.ts"));
  ({ default: app } = await import("../../src/server.ts"));
});

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const visitorRows = (site: string) => (db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site = ?").get(site) as { n: number }).n;
function decide(body: unknown, headers: Record<string, string> = {}) {
  return app.request("http://127.0.0.1/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/decide (PRISM-030)", () => {
  test("unknown site: empty decisions, no plan/usage, and no metered visitor row", async () => {
    const site = uid("nobody-site");
    const r = await decide({ visitorId: uid("v"), site }, { "fly-client-ip": "10.0.0.1" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ decisions: [], traits: {} });
    expect(visitorRows(site)).toBe(0);
  });

  test("demo site still decides unauthenticated, meters, and hides plan/usage", async () => {
    const vid = uid("v_gift");
    const before = visitorRows("demo");
    await app.request("http://127.0.0.1/api/identify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId: vid, site: "demo", traits: { intent: "gift" } }),
    });
    const r = await decide({ visitorId: vid, site: "demo" }, { "fly-client-ip": "10.0.0.2" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.decisions).toEqual([expect.objectContaining({ selector: "#hero", name: "Gift-buyer hero" })]);
    expect(body.plan).toBeUndefined();
    expect(body.usage).toBeUndefined();
    const anon = uid("v_anon");
    await decide({ visitorId: anon, site: "demo" }, { "fly-client-ip": "10.0.0.2" });
    expect(visitorRows("demo")).toBe(before + 2);
  });

  test("an authorized caller still gets plan and usage", async () => {
    const admin = await (await decide({ visitorId: uid("v"), site: "demo" }, { authorization: `Bearer ${ADMIN}`, "fly-client-ip": "10.0.0.3" })).json();
    expect(admin.plan).toBe("agency");
    expect(typeof admin.usage.visitors).toBe("number");
    const demoTok = await (await decide({ visitorId: uid("v"), site: "demo" }, { authorization: `Bearer ${DEMO}`, "fly-client-ip": "10.0.0.3" })).json();
    expect(demoTok.plan).toBe("agency");
  });

  test("one client can't inflate a site's metered visitors past the hourly cap", async () => {
    const before = visitorRows("demo");
    for (let i = 0; i < 12; i++) {
      const r = await decide({ visitorId: uid("v_flood"), site: "demo" }, { "fly-client-ip": "10.0.0.4" });
      expect(r.status).toBe(200);
      expect(Array.isArray((await r.json()).decisions)).toBe(true);
    }
    expect(visitorRows("demo")).toBe(before + 5);
  });

  test("request rate limit answers 429 with empty decisions (snippet fails open)", async () => {
    const vid = uid("v_rate");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await decide({ visitorId: vid, site: "demo" }, { "fly-client-ip": "10.0.0.5" });
      statuses.push(r.status);
      if (r.status === 429) expect((await r.json()).decisions).toEqual([]);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(20);
    expect(statuses.filter((s) => s === 429).length).toBe(5);
    // A different client is unaffected.
    expect((await decide({ visitorId: vid, site: "demo" }, { "fly-client-ip": "10.0.0.6" })).status).toBe(200);
  });

  test("invalid site names and oversized visitor ids are a 400 with empty decisions", async () => {
    for (const body of [{ visitorId: "v", site: "<script>" }, { visitorId: "x".repeat(200), site: "demo" }, { visitorId: 1, site: "demo" }]) {
      const r = await decide(body, { "fly-client-ip": "10.0.0.7" });
      expect(r.status).toBe(400);
      expect((await r.json()).decisions).toEqual([]);
    }
  });
});

describe("auth cookies (PRISM-031)", () => {
  const cookieFor = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + "="));

  test("OAuth state cookie is Secure, HttpOnly, SameSite=Lax on a public host", async () => {
    const r = await app.request("https://prism-personalize.fly.dev/auth/google");
    expect(r.status).toBe(302);
    const c = cookieFor(r, "prism_oauth_state")!;
    expect(c).toBeDefined();
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
  });

  test("behind a TLS-terminating proxy (X-Forwarded-Proto: https) it is Secure too", async () => {
    const r = await app.request("http://127.0.0.1/auth/google", { headers: { "x-forwarded-proto": "https" } });
    expect(cookieFor(r, "prism_oauth_state")).toContain("Secure");
  });

  test("plain-http loopback (local dev) omits Secure so the browser keeps the cookie", async () => {
    const r = await app.request("http://127.0.0.1/auth/google");
    const c = cookieFor(r, "prism_oauth_state")!;
    expect(c).not.toContain("Secure");
    expect(c).toContain("HttpOnly");
  });
});
