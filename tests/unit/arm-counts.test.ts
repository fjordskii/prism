import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileIsolated } from "../support/isolated";

const ADMIN = "unit-admin-token";

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  test("arm counts match the event log and decide stays fast", async () => {
    await runFileIsolated(join(import.meta.dir, "arm-counts.test.ts"));
  }, { timeout: 180_000 });
} else {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-counts-")), "prism.db");
  process.env.ADMIN_TOKEN = ADMIN;
  process.env.DEMO_TOKEN = "unit-demo-token";
  process.env.HOLDOUT_PCT = "0";
  process.env.PRISM_PLAN = "selfhost";
  process.env.DECIDE_RATE_PER_MIN = "1000000";
  process.env.DECIDE_NEW_VISITORS_PER_HOUR = "1000000";
  delete process.env.DEV_AUTH_EMAIL;

  const { db } = await import("../../src/db.ts");
  const { banditScore } = await import("../../src/bandit.ts");
  const { banditTotalsIncludingUnkeyed, experienceArms, installEventCounts, pooledTotals } = await import("../../src/counts.ts");
  const { default: app } = await import("../../src/server.ts");
  const { siteWriteKey } = await import("../../src/write-key.ts");

  function post(path: string, body: unknown) {
    const site = body && typeof body === "object" && body !== null && "site" in body
      ? String((body as { site: unknown }).site)
      : "";
    const key = path === "/api/events" ? siteWriteKey(site) : null;
    return app.request("http://127.0.0.1" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN}`,
        ...(key ? { "x-prism-key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function stats(site: string) {
    const res = await app.request("http://127.0.0.1/api/stats?site=" + site, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      variants: { id: number; name: string; impressions: number; conversions: number }[];
      control: { impressions: number; conversions: number };
      experiences: { audienceKey: string; treated: { impressions: number; conversions: number }; control: { impressions: number; conversions: number } }[];
    }>;
  }

  const raw = db.prepare(
    `SELECT
       COALESCE(SUM(type = 'impression'), 0) AS impressions,
       COALESCE(SUM(type = 'conversion'), 0) AS conversions
     FROM events
     WHERE variant_id IS ? AND (audience_key IS NULL OR audience_key = ?)`,
  );

  test("posted events, null keys, erasure, and a second boot match the raw sums", async () => {
    const site = "counts";
    const created = await post("/api/variants", { site, name: "Hero", selector: "#hero", ops: "[]", audience: "[]" });
    expect(created.status).toBe(201);
    const variantId = (await created.json()).id as number;

    const recorded = await post("/api/events", {
      site,
      visitorId: "alice",
      events: [
        { type: "impression", variantId, selector: "#hero", audienceKey: "[]" },
        { type: "impression", variantId, selector: "#hero", audienceKey: "[]" },
        { type: "conversion", variantId, selector: "#hero", audienceKey: "[]" },
        { type: "impression", variantId, selector: "#hero" },
        { type: "conversion", variantId, selector: "#hero", audienceKey: "[]" },
        { type: "impression", variantId: null, selector: "#hero", audienceKey: "[]" },
        { type: "conversion", variantId, selector: "#other" },
      ],
    });
    expect(recorded.status).toBe(200);
    expect((await recorded.json()).recorded).toBe(6);

    const body = await stats(site);
    const hero = body.variants.find((row) => row.id === variantId);
    expect(hero?.impressions).toBe(3);
    expect(hero?.conversions).toBe(2);
    expect(body.control.impressions).toBe(1);
    expect(body.control.conversions).toBe(0);
    const everyone = body.experiences.find((row) => row.audienceKey === "[]");
    expect(everyone?.treated.impressions).toBe(2);
    expect(everyone?.treated.conversions).toBe(2);
    expect(everyone?.control.impressions).toBe(1);
    expect(everyone?.control.conversions).toBe(0);

    const scored = banditTotalsIncludingUnkeyed(db, variantId, "[]");
    const fromLog = raw.get(variantId, "[]") as { impressions: number; conversions: number };
    expect(scored.impressions).toBe(Number(fromLog.impressions));
    expect(scored.conversions).toBe(Number(fromLog.conversions));
    expect(scored).toEqual({ impressions: 3, conversions: 2 });
    expect(banditTotalsIncludingUnkeyed(db, variantId, "gift")).toEqual({ impressions: 1, conversions: 0 });
    expect(experienceArms(db, site).some((row) => row.audience_key === "" && row.variant_id === variantId)).toBe(false);

    const before = banditTotalsIncludingUnkeyed(db, variantId, "[]");
    expect(() => db.transaction(() => {
      db.prepare(
        "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts, audience_key) VALUES (?, ?, ?, '#hero', 'impression', 1, '[]')",
      ).run(site, "alice", variantId);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(banditTotalsIncludingUnkeyed(db, variantId, "[]")).toEqual(before);

    const erased = await app.request(`http://127.0.0.1/api/visitors/alice?site=${site}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(erased.status).toBe(200);
    const afterErase = await stats(site);
    const heroAfter = afterErase.variants.find((row) => row.id === variantId);
    expect(heroAfter?.impressions).toBe(0);
    expect(heroAfter?.conversions).toBe(0);
    expect(afterErase.control.impressions).toBe(0);

    db.prepare(
      "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts, audience_key) VALUES (?, ?, ?, '#hero', 'impression', 1, '')",
    ).run(site, "bob", variantId);
    expect(banditTotalsIncludingUnkeyed(db, variantId, "")).toEqual({ impressions: 1, conversions: 0 });
    expect(banditTotalsIncludingUnkeyed(db, variantId, "[]").impressions).toBe(0);
    const emptyArm = experienceArms(db, site).find((row) => row.audience_key === "" && row.variant_id === variantId);
    expect(emptyArm?.impressions).toBe(1);

    const pooledBefore = pooledTotals(db, site).variants.get(variantId);
    installEventCounts(db);
    expect(pooledTotals(db, site).variants.get(variantId)).toEqual(pooledBefore);
  });

  test("a database that already has events backfills once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "prism-precount-")), "prism.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        variant_id INTEGER,
        selector TEXT NOT NULL,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        audience_key TEXT
      );
    `);
    const insert = old.prepare(
      "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts, audience_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("legacy", "v", 7, "#hero", "impression", 1, null);
    insert.run("legacy", "v", 7, "#hero", "impression", 2, "[]");
    insert.run("legacy", "v", 7, "#hero", "conversion", 3, "[]");
    insert.run("legacy", "v", null, "#hero", "impression", 4, "[]");
    old.close();

    const next = new Database(path);
    next.exec(`
      CREATE TABLE variants (
        id INTEGER PRIMARY KEY,
        site TEXT NOT NULL,
        name TEXT NOT NULL,
        selector TEXT NOT NULL,
        ops TEXT NOT NULL,
        audience TEXT NOT NULL,
        weight REAL NOT NULL,
        active INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    next.prepare(
      "INSERT INTO variants (id, site, name, selector, ops, audience, weight, active, created_at) VALUES (7, 'legacy', 'Hero', '#hero', '[]', '[]', 1, 1, 1)",
    ).run();
    installEventCounts(next);
    expect(banditTotalsIncludingUnkeyed(next, 7, "[]")).toEqual({ impressions: 2, conversions: 1 });
    expect(pooledTotals(next, "legacy").control).toEqual({ impressions: 1, conversions: 0 });
    expect(pooledTotals(next, "legacy").variants.get(7)).toEqual({ impressions: 2, conversions: 1 });
    const arms = experienceArms(next, "legacy");
    expect(arms.find((row) => row.variant_id === 7)?.impressions).toBe(1);
    expect(arms.find((row) => row.variant_id === null)?.impressions).toBe(1);
    installEventCounts(next);
    expect(banditTotalsIncludingUnkeyed(next, 7, "[]")).toEqual({ impressions: 2, conversions: 1 });
    next.close();
  });

  test("banditScore stays under 5 ms at a quarter million events", async () => {
    const site = "fast";
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const created = await post("/api/variants", { site, name: `v${i}`, selector: "#hero", ops: "[]", audience: "[]" });
      expect(created.status).toBe(201);
      ids.push((await created.json()).id as number);
    }
    db.exec("DROP TRIGGER IF EXISTS events_count_insert");
    db.exec("DROP TRIGGER IF EXISTS events_count_delete");
    db.exec("DROP TRIGGER IF EXISTS events_count_no_update");
    const series = (n: number) => Array.from({ length: n }, (_, i) => `(${i})`).join(",");
    db.prepare(`
      WITH
        a(n) AS (VALUES ${series(50)}),
        b(n) AS (VALUES ${series(50)}),
        c(n) AS (VALUES ${series(100)}),
        seq(i) AS (SELECT a.n + 50 * b.n + 2500 * c.n FROM a, b, c)
      INSERT INTO events (site, visitor_id, variant_id, selector, type, ts, audience_key)
      SELECT
        'fast',
        'crowd',
        CASE i % 5 WHEN 0 THEN ?1 WHEN 1 THEN ?2 WHEN 2 THEN ?3 WHEN 3 THEN ?4 ELSE ?5 END,
        '#hero',
        CASE WHEN i % 20 = 0 THEN 'conversion' ELSE 'impression' END,
        1,
        CASE WHEN i % 2 = 0 THEN NULL ELSE '[]' END
      FROM seq
    `).run(ids[0], ids[1], ids[2], ids[3], ids[4]);
    db.exec("DELETE FROM counts_meta");
    installEventCounts(db);

    const impressions = ids.reduce((sum, id) => sum + banditTotalsIncludingUnkeyed(db, id, "[]").impressions, 0);
    expect(impressions).toBe(237_500);

    const decided = await app.request("http://127.0.0.1/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId: "crowd", site }),
    });
    expect(decided.status).toBe(200);
    const decision = await decided.json() as { decisions?: { variantId: number | null }[] };
    expect(ids).toContain(decision.decisions?.[0]?.variantId);

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      for (const id of ids) banditScore(id, 1, "[]");
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
    expect(p95).toBeLessThan(5);
  }, { timeout: 60_000 });

  afterAll(() => {
    db.close();
  });
}
