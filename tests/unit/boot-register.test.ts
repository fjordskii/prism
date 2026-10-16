// PRISM-042: a visitor-only slug is not a site. Boot must not register it
// or let it consume a capped plan's site slot. A sites row still gets a
// write key, and a key already on that row stays put.
// PRISM_PLAN is read when src/plans.ts loads, so this case boots in a child.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreEnv, runFileIsolated, snapshotEnv, type EnvSnap } from "../support/isolated";

const ADMIN = "boot-register-admin";
const JUNK = "zz-random-28853";
const KEYED = "keyed-shop";
const ROW = "row-shop";
const KEPT_KEY = "wk_keep_this_key";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  let snap: EnvSnap | undefined;
  beforeAll(() => {
    snap = snapshotEnv();
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("boot registration runs in its own process", async () => {
    await runFileIsolated(join(import.meta.dir, "boot-register.test.ts"), {
      PRISM_PLAN: "growth",
    });
  }, { timeout: 60_000 });
} else {
  let app: App;
  let db: import("bun:sqlite").Database;
  let snap: EnvSnap | undefined;

  beforeAll(async () => {
    snap = snapshotEnv();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-boot-reg-")), "prism.db");
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.DEMO_TOKEN = "boot-register-demo";
    process.env.READONLY_TOKENS = "";
    process.env.HOLDOUT_PCT = "0";
    process.env.PRISM_PLAN = "growth";
    delete process.env.DEV_AUTH_EMAIL;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.SITE_WRITE_KEY;
    delete process.env.SITE_WRITE_KEY_GRACE_UNTIL;
    delete process.env.BASE_URL;
    seed(process.env.DB_PATH);
    ({ default: app } = await import("../../src/server.ts"));
    ({ db } = await import("../../src/db.ts"));
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("visitor-only names are not registered and do not consume the growth cap", async () => {
    const sites = db.prepare(
      "SELECT site, plan, write_key FROM sites ORDER BY site",
    ).all() as { site: string; plan: string; write_key: string | null }[];
    expect(sites.map((row) => row.site)).toEqual([KEYED, ROW]);
    expect(sites[0]).toEqual({ site: KEYED, plan: "growth", write_key: KEPT_KEY });
    expect(sites[1]?.site).toBe(ROW);
    expect(sites[1]?.plan).toBe("growth");
    expect(sites[1]?.write_key ?? "").toMatch(/^wk_/);
    expect(sites[1]?.write_key).not.toBe(KEPT_KEY);
    expect(db.prepare("SELECT site FROM sites WHERE site = ?").get(JUNK)).toEqual(null);
    expect(db.prepare("SELECT id, site, visits, traits FROM visitors").all()).toEqual([
      { id: "junk-vid", site: JUNK, visits: 1, traits: "{}" },
    ]);
    expect(db.prepare("SELECT site FROM variants WHERE site = 'variant-only-shop'").get()).toEqual({
      site: "variant-only-shop",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE site = 'event-only-shop'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE site = 'order-only-shop'").get()).toEqual({ n: 1 });

    const { issueSiteWriteKeys } = await import("../../src/write-key.ts");
    const filled = sites[1]?.write_key;
    expect(issueSiteWriteKeys()).toEqual({ issued: 0 });
    expect(db.prepare("SELECT write_key FROM sites WHERE site = ?").get(KEYED)).toEqual({ write_key: KEPT_KEY });
    expect(db.prepare("SELECT write_key FROM sites WHERE site = ?").get(ROW)).toEqual({ write_key: filled });
    expect(db.prepare("SELECT COUNT(*) AS n FROM visitors").get()).toEqual({ n: 1 });

    const third = await createVariant(app, "third-shop");
    expect(third.status).toBe(201);
    const fourth = await createVariant(app, "fourth-shop");
    expect(fourth.status).toBe(402);
    expect(await fourth.json()).toEqual({ error: "site_cap", cap: 3 });
    expect(db.prepare("SELECT site FROM sites ORDER BY site").all()).toEqual([
      { site: KEYED },
      { site: ROW },
      { site: "third-shop" },
    ]);
    expect(db.prepare("SELECT id, site, visits, traits FROM visitors WHERE site = ?").get(JUNK)).toEqual({
      id: "junk-vid", site: JUNK, visits: 1, traits: "{}",
    });
  });
}

function seed(path: string) {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE visitors (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      traits TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE sites (
      site TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      write_key TEXT
    );
  `);
  raw.prepare(
    "INSERT INTO sites (site, plan, created_at, write_key) VALUES (?, 'growth', ?, ?)",
  ).run(KEYED, 1, KEPT_KEY);
  raw.prepare(
    "INSERT INTO sites (site, plan, created_at, write_key) VALUES (?, 'growth', ?, NULL)",
  ).run(ROW, 2);
  raw.prepare(
    "INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits) VALUES (?, ?, 10, 20, 1, '{}')",
  ).run("junk-vid", JUNK);
  raw.exec(`
    CREATE TABLE variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      name TEXT NOT NULL,
      selector TEXT NOT NULL,
      ops TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '{}',
      weight REAL NOT NULL DEFAULT 1,
      starts_at INTEGER,
      ends_at INTEGER,
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
    CREATE TABLE orders (
      site TEXT NOT NULL,
      order_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      value_minor INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (site, order_id)
    );
  `);
  raw.prepare(
    "INSERT INTO variants (site, name, selector, ops, audience, created_at) VALUES ('variant-only-shop', 'Hero', '#hero', '[]', '[]', 4)",
  ).run();
  raw.prepare(
    "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES ('event-only-shop', 'e1', NULL, '#hero', 'impression', 5)",
  ).run();
  raw.prepare(
    "INSERT INTO orders (site, order_id, visitor_id, currency, value_minor, ts) VALUES ('order-only-shop', 'ord_1', 'o1', 'USD', 1000, 6)",
  ).run();
  raw.close();
}

function createVariant(app: App, site: string) {
  return app.request("http://127.0.0.1/api/variants", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN}`,
    },
    body: JSON.stringify({ site, name: "Hero", selector: "#hero", ops: "[]", audience: "[]" }),
  });
}
