// Order ingest, exposure credits, currency split, intervals, and boot migration.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrderEventFromCheckout, recordedCheckout } from "../support/pixel.ts";

const ADMIN = "unit-admin-token";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-unit-")), "prism.db");
process.env.ADMIN_TOKEN = ADMIN;
process.env.DEMO_TOKEN = "unit-demo-token";
process.env.HOLDOUT_PCT = "0";
process.env.PRISM_PLAN = "selfhost";
process.env.GOOGLE_CLIENT_ID = "unit-client-id";
process.env.GOOGLE_CLIENT_SECRET = "unit-client-secret";
process.env.DECIDE_RATE_PER_MIN = "20";
process.env.DECIDE_NEW_VISITORS_PER_HOUR = "5";

await import("../../src/seed.ts");
const { default: app } = await import("../../src/server.ts");

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request("http://127.0.0.1" + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, ...headers },
    body: JSON.stringify(body),
  });
}

async function events(site: string, visitorId: string, list: unknown[]) {
  const r = await post("/api/events", { site, visitorId, events: list });
  return { status: r.status, body: await r.json() };
}

async function stats(site: string) {
  const r = await app.request("http://127.0.0.1/api/stats?site=" + site, {
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  expect(r.status).toBe(200);
  return r.json();
}

async function variant(site: string, name: string, selector = "#hero") {
  const r = await post("/api/variants", { site, name, selector, ops: "[]", audience: "[]" });
  expect(r.status).toBe(201);
  return (await r.json()).id as number;
}

describe("POST /api/events order", () => {
  test("a valid order from a visitor with an impression is credited only to that arm", async () => {
    const site = uid("arm");
    const hero = await variant(site, "Hero");
    const other = await variant(site, "Other", "#grid");
    const vid = uid("v");

    const early = await events(site, vid, [{ type: "order", orderId: "ord_early", value: "10.00", currency: "USD" }]);
    expect(early.status).toBe(200);
    expect(early.body.recorded).toBe(0);
    expect(early.body.dropped).toEqual([{ index: 0, reason: "no impression" }]);

    const seen = await events(site, vid, [
      { type: "impression", variantId: hero, selector: "#hero" },
      { type: "conversion", variantId: hero, selector: "#hero" },
    ]);
    expect(seen.body.recorded).toBe(2);

    const before = await stats(site);
    const placed = await events(site, vid, [{ type: "order", orderId: "ord_1", value: "10.00", currency: "usd", variantId: other, selector: "#grid" }]);
    expect(placed.status).toBe(200);
    expect(placed.body.recorded).toBe(1);

    const again = await events(site, vid, [{ type: "order", orderId: "ord_1", value: "99.00", currency: "EUR" }]);
    expect(again.status).toBe(200);
    expect(again.body.recorded).toBe(0);
    expect(again.body.duplicates).toBe(1);

    await events(site, vid, [{ type: "impression", variantId: other, selector: "#grid" }]);

    const after = await stats(site);
    const heroRow = after.variants.find((v: { id: number }) => v.id === hero);
    const otherRow = after.variants.find((v: { id: number }) => v.id === other);
    const heroBefore = before.variants.find((v: { id: number }) => v.id === hero);
    expect(heroRow.orders).toBe(1);
    expect(heroRow.revenue).toEqual([expect.objectContaining({ currency: "USD", revenue: "10.00", revenueMinor: 1000, orders: 1 })]);
    expect(otherRow.orders).toBe(0);
    expect(otherRow.revenue).toEqual([]);
    expect(after.control.orders).toBe(0);
    expect(heroRow.impressions).toBe(heroBefore.impressions);
    expect(heroRow.conversions).toBe(heroBefore.conversions);
    expect(heroRow.rate).toBe(heroBefore.rate);
    expect(heroRow.ci95).toEqual(heroBefore.ci95);
    expect(heroRow.rate).toBe(1);
  });

  test("the same order id on another site is a different order", async () => {
    const a = uid("sitea");
    const b = uid("siteb");
    const va = await variant(a, "A");
    const vb = await variant(b, "B");
    await events(a, "va", [{ type: "impression", variantId: va, selector: "#hero" }]);
    await events(b, "vb", [{ type: "impression", variantId: vb, selector: "#hero" }]);
    expect((await events(a, "va", [{ type: "order", orderId: "shared", value: "1.00", currency: "USD" }])).body.recorded).toBe(1);
    expect((await events(b, "vb", [{ type: "order", orderId: "shared", value: "2.00", currency: "USD" }])).body.recorded).toBe(1);
    expect((await stats(a)).variants[0].revenue[0].revenue).toBe("1.00");
    expect((await stats(b)).variants[0].revenue[0].revenue).toBe("2.00");
  });

  test("a control impression credits the order to control and not to a variant", async () => {
    const site = uid("ctl");
    const hero = await variant(site, "Hero");
    const vid = uid("c");
    await events(site, vid, [{ type: "impression", variantId: null, selector: "#hero" }]);
    const r = await events(site, vid, [{ type: "order", orderId: "ord_c", value: "12.50", currency: "USD" }]);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(1);
    const s = await stats(site);
    expect(s.control.orders).toBe(1);
    expect(s.control.revenue[0].revenue).toBe("12.50");
    expect(s.variants.find((v: { id: number }) => v.id === hero).orders).toBe(0);
  });

  test("malformed orderId, value, or currency is a 400 that names the field", async () => {
    const site = uid("bad");
    const cases: [unknown, string, string][] = [
      [{ type: "order", value: "1.00", currency: "USD" }, "orderId", "missing orderId"],
      [{ type: "order", orderId: "", value: "1.00", currency: "USD" }, "orderId", "missing orderId"],
      [{ type: "order", orderId: "x".repeat(129), value: "1.00", currency: "USD" }, "orderId", "invalid orderId"],
      [{ type: "order", orderId: 820982911946154508, value: "1.00", currency: "USD" }, "orderId", "invalid orderId"],
      [{ type: "order", orderId: "x", value: -1, currency: "USD" }, "value", "invalid value"],
      [{ type: "order", orderId: "x", value: "1.234", currency: "USD" }, "value", "invalid value"],
      [{ type: "order", orderId: "x", value: "nope", currency: "USD" }, "value", "invalid value"],
      [{ type: "order", orderId: "x", currency: "USD" }, "value", "invalid value"],
      [{ type: "order", orderId: "x", value: "1.00", currency: "US" }, "currency", "invalid currency"],
      [{ type: "order", orderId: "x", value: "1.00", currency: "USDD" }, "currency", "invalid currency"],
      [{ type: "order", orderId: "x", value: "1.00" }, "currency", "invalid currency"],
    ];
    for (const [event, field, message] of cases) {
      const r = await events(site, uid("v"), [event]);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid order");
      expect(r.body.recorded).toBe(0);
      expect(r.body.rejected).toEqual([{ index: 0, field, message }]);
    }
    const mixed = await events(site, uid("v"), [
      { type: "impression", variantId: null, selector: "#hero" },
      { type: "order", orderId: "bad", value: "1.00", currency: "12" },
    ]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.recorded).toBe(1);
    expect(mixed.body.rejected[0].field).toBe("currency");
  });

  test("JPY and KWD keep their minor-unit exponents", async () => {
    const site = uid("exp");
    const id = await variant(site, "Hero");
    const vid = uid("v");
    await events(site, vid, [{ type: "impression", variantId: id, selector: "#hero" }]);
    expect((await events(site, vid, [{ type: "order", orderId: "jpy", value: 1500, currency: "JPY" }])).status).toBe(200);
    expect((await events(site, vid, [{ type: "order", orderId: "kwd", value: "1.234", currency: "KWD" }])).status).toBe(200);
    const tooFine = await events(site, vid, [{ type: "order", orderId: "kwd2", value: "1.2345", currency: "KWD" }]);
    expect(tooFine.status).toBe(400);
    expect(tooFine.body.rejected[0].field).toBe("value");
    const revenue = (await stats(site)).variants[0].revenue;
    expect(revenue).toEqual([
      expect.objectContaining({ currency: "JPY", revenue: "1500", revenueMinor: 1500 }),
      expect.objectContaining({ currency: "KWD", revenue: "1.234", revenueMinor: 1234 }),
    ]);
  });

  test("two currencies stay split, with normal 95% intervals on a fixed sample", async () => {
    const site = uid("ci");
    const id = await variant(site, "Hero");
    const visitors = ["a", "b", "c", "d"].map((n) => uid(n));
    for (const vid of visitors) {
      expect((await events(site, vid, [{ type: "impression", variantId: id, selector: "#hero" }])).body.recorded).toBe(1);
    }
    expect((await events(site, visitors[0]!, [{ type: "order", orderId: "usd_a", value: "10.00", currency: "USD" }])).body.recorded).toBe(1);
    expect((await events(site, visitors[1]!, [{ type: "order", orderId: "usd_b", value: "30.00", currency: "USD" }])).body.recorded).toBe(1);
    expect((await events(site, visitors[0]!, [{ type: "order", orderId: "eur_a", value: "5.00", currency: "EUR" }])).body.recorded).toBe(1);

    const row = (await stats(site)).variants[0];
    expect(row.impressions).toBe(4);
    expect(row.conversions).toBe(0);
    expect(row.rate).toBe(0);
    expect(row.ci95[0]).toBe(0);
    expect(row.ci95[1]).toBeCloseTo(0.48990002040399916, 10);
    expect(row.orders).toBe(3);
    expect(row.ordersPerVisitor).toBe(0.75);
    expect(row.ordersCi95[0]).toBe(0);
    expect(row.ordersCi95[1]).toBeCloseTo(6.7531142624048455, 8);
    expect(row.ordersPerVisitorCi95[0]).toBe(0);
    expect(row.ordersPerVisitorCi95[1]).toBeCloseTo(1.6882785656012114, 8);

    const usd = row.revenue.find((r: { currency: string }) => r.currency === "USD");
    const eur = row.revenue.find((r: { currency: string }) => r.currency === "EUR");
    expect(usd.orders).toBe(2);
    expect(usd.revenueMinor).toBe(4000);
    expect(usd.revenue).toBe("40.00");
    expect(usd.revenueCi95).toEqual(["0.00", "95.44"]);
    expect(usd.rpv).toBe("10.00");
    expect(usd.rpvCi95).toEqual(["0.00", "23.86"]);
    expect(usd.aov).toBe("20.00");
    expect(usd.aovCi95).toEqual(["0.40", "39.60"]);
    expect(eur.orders).toBe(1);
    expect(eur.revenue).toBe("5.00");
    expect(eur.revenueCi95).toEqual(["0.00", "14.80"]);
    expect(eur.rpv).toBe("1.25");
    expect(eur.rpvCi95).toEqual(["0.00", "3.70"]);
    expect(eur.aov).toBe("5.00");
    expect(eur.aovCi95).toBe(null);
    expect(usd.revenueMinor + eur.revenueMinor).not.toBe(row.revenueMinor);
    expect(row.revenueMinor).toBeUndefined();
  });

  test("erasure removes the visitor's orders from export and stats", async () => {
    const site = uid("dsr");
    const id = await variant(site, "Hero");
    const vid = uid("v");
    await events(site, vid, [{ type: "impression", variantId: id, selector: "#hero" }]);
    await events(site, vid, [{ type: "order", orderId: "gone", value: "8.00", currency: "USD" }]);
    const exported = await (await app.request(`http://127.0.0.1/api/export?site=${site}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(exported.orders).toEqual([expect.objectContaining({ order_id: "gone", value_minor: 800, currency: "USD" })]);
    const del = await app.request(`http://127.0.0.1/api/visitors/${vid}?site=${site}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(del.status).toBe(200);
    const after = await (await app.request(`http://127.0.0.1/api/visitors/${vid}?site=${site}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
    expect(after.orders).toEqual([]);
    expect((await stats(site)).variants[0].orders).toBe(0);
  });
});

describe("Shopify custom pixel fixture", () => {
  test("checkout_completed becomes one order event and drops the buyer email", () => {
    const map = loadOrderEventFromCheckout();
    const recorded = recordedCheckout();
    const body = map(recorded.data.checkout, "v_fixture");
    expect(body).toEqual({
      site: "yourstore",
      visitorId: "v_fixture",
      events: [{
        type: "order",
        orderId: "gid://shopify/Order/820982911946154508",
        value: "48",
        currency: "USD",
      }],
    });
    expect(JSON.stringify(body)).not.toContain("buyer@example.test");
    expect(map(recorded.data.checkout, "")).toBe(null);
    expect(map({ totalPrice: { amount: 48, currencyCode: "USD" } }, "v_fixture")).toBe(null);
  });
});

describe("boot migration of a pre-change database", () => {
  test("orders tables appear and the old click stats still match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-legacy-"));
    const path = join(dir, "legacy.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE visitors (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        visits INTEGER NOT NULL DEFAULT 0,
        traits TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        name TEXT NOT NULL,
        selector TEXT NOT NULL,
        ops TEXT NOT NULL,
        audience TEXT NOT NULL DEFAULT '{}',
        weight REAL NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        variant_id INTEGER,
        selector TEXT NOT NULL,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE sites (
        site TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE accounts (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'editor',
        created_at INTEGER NOT NULL
      );
    `);
    old.prepare("INSERT INTO variants (site, name, selector, ops, audience, weight, active, created_at) VALUES (?, ?, ?, '[]', '[]', 1, 1, ?)").run("legacy", "Legacy hero", "#hero", 1_700_000_000_000);
    const ins = old.prepare("INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES (?, ?, ?, '#hero', ?, ?)");
    for (let i = 0; i < 10; i++) ins.run("legacy", "vis_" + i, 1, "impression", 1_700_000_001_000 + i);
    for (let i = 0; i < 4; i++) ins.run("legacy", "vis_" + i, 1, "conversion", 1_700_000_002_000 + i);
    for (let i = 0; i < 5; i++) ins.run("legacy", "ctl_" + i, null, "impression", 1_700_000_003_000 + i);
    ins.run("legacy", "ctl_0", null, "conversion", 1_700_000_004_000);
    old.close();

    const script = `
      const { default: app } = await import("./src/server.ts");
      const { db } = await import("./src/db.ts");
      const res = await app.request("http://127.0.0.1/api/stats?site=legacy", { headers: { authorization: "Bearer mig-token" } });
      const stats = await res.json();
      const events = db.prepare("SELECT COUNT(*) AS n FROM events").get();
      const variant = db.prepare("SELECT name, starts_at, ends_at FROM variants WHERE site = 'legacy'").get();
      const orders = db.prepare("SELECT COUNT(*) AS n FROM orders").get();
      const credits = db.prepare("SELECT COUNT(*) AS n FROM order_credits").get();
      console.log("MIG_RESULT " + JSON.stringify({ status: res.status, stats, events, variant, orders, credits }));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DB_PATH: path,
        ADMIN_TOKEN: "mig-token",
        PRISM_PLAN: "selfhost",
        HOLDOUT_PCT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, err).toBe(0);
    const line = out.split("\n").find((l) => l.startsWith("MIG_RESULT "));
    const result = JSON.parse(line!.slice("MIG_RESULT ".length));
    expect(result.status).toBe(200);
    expect(result.events.n).toBe(20);
    expect(result.variant).toEqual({ name: "Legacy hero", starts_at: null, ends_at: null });
    expect(result.orders.n).toBe(0);
    expect(result.credits.n).toBe(0);
    expect(result.stats.variants[0].impressions).toBe(10);
    expect(result.stats.variants[0].conversions).toBe(4);
    expect(result.stats.variants[0].rate).toBe(0.4);
    expect(result.stats.variants[0].ci95[0]).toBeCloseTo(0.16817758120350967, 10);
    expect(result.stats.variants[0].ci95[1]).toBeCloseTo(0.6873304525498135, 10);
    expect(result.stats.variants[0].orders).toBe(0);
    expect(result.stats.variants[0].revenue).toEqual([]);
    expect(result.stats.control.impressions).toBe(5);
    expect(result.stats.control.conversions).toBe(1);
    expect(result.stats.control.orders).toBe(0);
  });
});
