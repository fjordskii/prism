import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileIsolated } from "../support/isolated";

const ADMIN = "write-key-admin";
const DEMO = "write-key-demo";

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  test("per-site write keys bind identify, events, and orders", async () => {
    await runFileIsolated(join(import.meta.dir, "write-key.test.ts"), { PRISM_WRITE_KEY_CASE: "1" });
  }, { timeout: 60_000 });
} else {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-wk-")), "prism.db");
  process.env.ADMIN_TOKEN = ADMIN;
  process.env.DEMO_TOKEN = DEMO;
  process.env.HOLDOUT_PCT = "0";
  process.env.PRISM_PLAN = "selfhost";
  process.env.GOOGLE_CLIENT_ID = "wk-client";
  process.env.GOOGLE_CLIENT_SECRET = "wk-secret";
  delete process.env.DEV_AUTH_EMAIL;
  delete process.env.SITE_WRITE_KEY;
  delete process.env.SITE_WRITE_KEY_GRACE_UNTIL;

  await import("../../src/seed.ts");
  const { db } = await import("../../src/db.ts");
  const { default: app } = await import("../../src/server.ts");
  const { siteWriteKey, injectDemoWriteKey } = await import("../../src/write-key.ts");

  const origin = "http://127.0.0.1";

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await app.request(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }

  async function get(path: string, headers: Record<string, string> = {}) {
    const r = await app.request(origin + path, { headers });
    return { status: r.status, body: await r.json() };
  }

  async function mint(site: string) {
    const r = await post("/api/variants", { site, name: "Hero", selector: "#hero", ops: "[]", audience: "[]" }, {
      authorization: `Bearer ${ADMIN}`,
    });
    expect(r.status).toBe(201);
    const key = siteWriteKey(site);
    expect(key).toBeTruthy();
    return { id: r.body.id as number, key: key! };
  }

  test("a missing or cross-site key is refused for identify, events, and orders", async () => {
    const ada = await mint("ada");
    const ben = await mint("ben");
    const vid = "v-cross";

    const missingId = await post("/api/identify", { visitorId: vid, site: "ada", traits: { intent: "gift" } });
    expect(missingId).toEqual({ status: 401, body: { error: "bad write key" } });

    const crossId = await post("/api/identify", { visitorId: vid, site: "ada", traits: { intent: "gift" } }, {
      "x-prism-key": ben.key,
    });
    expect(crossId).toEqual({ status: 401, body: { error: "bad write key" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site = 'ada' AND id = ?").get(vid)).toEqual({ n: 0 });

    const okId = await post("/api/identify", { visitorId: vid, site: "ada", traits: { intent: "gift" } }, {
      "x-prism-key": ada.key,
    });
    expect(okId.status).toBe(200);

    const missingEv = await post("/api/events", {
      site: "ada", visitorId: vid, events: [{ type: "impression", variantId: ada.id, selector: "#hero" }],
    });
    expect(missingEv).toEqual({ status: 401, body: { error: "bad write key" } });

    const crossEv = await post("/api/events", {
      site: "ada", visitorId: vid, events: [{ type: "impression", variantId: ada.id, selector: "#hero" }],
    }, { "x-prism-key": ben.key });
    expect(crossEv).toEqual({ status: 401, body: { error: "bad write key" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE site = 'ada'").get()).toEqual({ n: 0 });

    const okEv = await post("/api/events", {
      site: "ada", visitorId: vid, events: [{ type: "impression", variantId: ada.id, selector: "#hero" }],
    }, { "x-prism-key": ada.key });
    expect(okEv.status).toBe(200);
    expect(okEv.body.recorded).toBe(1);

    const crossOrder = await post("/api/events", {
      site: "ada", visitorId: vid, events: [{ type: "order", orderId: "ord_x", value: "10.00", currency: "USD" }],
    }, { "x-prism-key": ben.key });
    expect(crossOrder).toEqual({ status: 401, body: { error: "bad write key" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE site = 'ada'").get()).toEqual({ n: 0 });

    const okOrder = await post("/api/events", {
      site: "ada", visitorId: vid, events: [{ type: "order", orderId: "ord_ok", value: "10.00", currency: "USD" }],
    }, { "x-prism-key": ada.key });
    expect(okOrder.status).toBe(200);
    expect(okOrder.body.recorded).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE site = 'ada' AND order_id = 'ord_ok'").get()).toEqual({ n: 1 });
  });

  test("rotating a key rejects the old one and accepts the new one", async () => {
    const site = "rotate-shop";
    const minted = await mint(site);
    const vid = "v-rot";
    const before = await post("/api/identify", { visitorId: vid, site, traits: { a: 1 } }, { "x-prism-key": minted.key });
    expect(before.status).toBe(200);

    const rotated = await post(`/api/sites/${site}/write-key`, {}, { authorization: `Bearer ${ADMIN}` });
    expect(rotated.status).toBe(200);
    expect(rotated.body.writeKey).toBeTruthy();
    expect(rotated.body.writeKey).not.toBe(minted.key);
    expect(rotated.body.snippet).toContain(`data-key="${rotated.body.writeKey}"`);

    const oldKey = await post("/api/identify", { visitorId: vid + "2", site, traits: { a: 2 } }, {
      "x-prism-key": minted.key,
    });
    expect(oldKey).toEqual({ status: 401, body: { error: "bad write key" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE id = ?").get(vid + "2")).toEqual({ n: 0 });

    const newKey = await post("/api/identify", { visitorId: vid + "2", site, traits: { a: 2 } }, {
      "x-prism-key": rotated.body.writeKey,
    });
    expect(newKey.status).toBe(200);
  });

  test("the shared SITE_WRITE_KEY works with a warning during grace and is rejected after", async () => {
    const site = "grace-shop";
    await mint(site);
    process.env.SITE_WRITE_KEY = "legacy-shared-key";
    delete process.env.SITE_WRITE_KEY_GRACE_UNTIL;

    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    const open = await post("/api/events", {
      site, visitorId: "v-grace", events: [{ type: "impression", variantId: null, selector: "#hero" }],
    }, { "x-prism-key": "legacy-shared-key" });
    console.warn = warn;
    expect(open.status).toBe(200);
    expect(open.body.recorded).toBe(1);
    expect(warnings.some((line) => line.includes("legacy SITE_WRITE_KEY accepted for site grace-shop"))).toBe(true);

    process.env.SITE_WRITE_KEY_GRACE_UNTIL = "1";
    const closed = await post("/api/events", {
      site, visitorId: "v-grace-2", events: [{ type: "impression", variantId: null, selector: "#hero" }],
    }, { "x-prism-key": "legacy-shared-key" });
    expect(closed).toEqual({ status: 401, body: { error: "bad write key" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE visitor_id = 'v-grace-2'").get()).toEqual({ n: 0 });

    const own = await post("/api/events", {
      site, visitorId: "v-grace-3", events: [{ type: "impression", variantId: null, selector: "#hero" }],
    }, { "x-prism-key": siteWriteKey(site)! });
    expect(own.status).toBe(200);
    delete process.env.SITE_WRITE_KEY;
    delete process.env.SITE_WRITE_KEY_GRACE_UNTIL;
  });

  test("owners can read the key and editors cannot", async () => {
    const viewed = await get("/api/sites/demo/write-key", { authorization: `Bearer ${ADMIN}` });
    expect(viewed.status).toBe(200);
    expect(viewed.body.writeKey).toBe(siteWriteKey("demo"));
    expect(viewed.body.snippet).toContain("data-key=");

    const demoTok = await get("/api/sites/demo/write-key", { authorization: `Bearer ${DEMO}` });
    expect(demoTok.status).toBe(403);

    const demoPage = await app.request(origin + "/demo/");
    expect(demoPage.status).toBe(200);
    const html = await demoPage.text();
    expect(html).toContain(`data-key="${siteWriteKey("demo")}"`);
    expect(injectDemoWriteKey('<script defer src="/snippet.js" data-site="demo" data-selectors="#hero"></script>', "wk_x"))
      .toBe('<script defer src="/snippet.js" data-site="demo" data-key="wk_x" data-selectors="#hero"></script>');
  });
}
