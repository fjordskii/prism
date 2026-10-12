// PRISM-035: growth site cap and the shadow monthly visitor limit.
// PRISM_PLAN is captured when src/plans.ts loads, so each case boots Prism in a
// child process. The parent must not assign that env; it leaked across suites before.
// Tokens below are throwaway values for this process. Do not log them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreEnv, runFileIsolated, snapshotEnv, type EnvSnap } from "../support/isolated";

const ADMIN = "unit-admin-token";
const SHADOW_CAP = 10_000;
let snap: EnvSnap | undefined;

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  beforeAll(() => {
    snap = snapshotEnv();
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("growth site cap runs in its own process", async () => {
    await runFileIsolated(join(import.meta.dir, "plan-limits.test.ts"), {
      PRISM_PLAN: "growth",
      PRISM_LIMIT_CASE: "site-cap",
    });
  }, { timeout: 60_000 });

  test("shadow visitor limit runs in its own process", async () => {
    await runFileIsolated(join(import.meta.dir, "plan-limits.test.ts"), {
      PRISM_PLAN: "shadow",
      PRISM_LIMIT_CASE: "visitors",
    });
  }, { timeout: 60_000 });
} else if (process.env.PRISM_LIMIT_CASE === "site-cap") {
  let app: App;
  let db: import("bun:sqlite").Database;

  beforeAll(async () => {
    snap = snapshotEnv();
    ({ app, db } = await boot("growth"));
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("sites 1-3 succeed and the fourth returns 402 site_cap", async () => {
    for (const site of ["growth-1", "growth-2", "growth-3"]) {
      const res = await createVariant(app, site);
      expect(res.status, site).toBe(201);
    }
    const blocked = await createVariant(app, "growth-4");
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({ error: "site_cap", cap: 3 });
    expect(db.prepare("SELECT site, plan FROM sites ORDER BY site").all()).toEqual([
      { site: "growth-1", plan: "growth" },
      { site: "growth-2", plan: "growth" },
      { site: "growth-3", plan: "growth" },
    ]);
  });
} else if (process.env.PRISM_LIMIT_CASE === "visitors") {
  let app: App;
  let db: import("bun:sqlite").Database;
  const site = "shadow-shop";

  beforeAll(async () => {
    snap = snapshotEnv();
    ({ app, db } = await boot("shadow"));
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("just under the visitor limit is not overLimit, and past 10,000 decide shadows", async () => {
    const created = await createVariant(app, site);
    expect(created.status).toBe(201);
    expect(db.prepare("SELECT plan FROM sites WHERE site = ?").get(site)).toEqual({ plan: "shadow" });

    // overLimit is a strict greater-than on the 10_000 cap, so a full cap is still inside the plan.
    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits) VALUES (?, ?, ?, ?, 1, '{}')"
    );
    db.transaction(() => {
      for (let i = 0; i < SHADOW_CAP; i++) insert.run(`vis-${i}`, site, now, now);
    })();

    const counted = () => (db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site = ?").get(site) as { n: number }).n;
    expect(counted()).toBe(SHADOW_CAP);

    // A shadow plan does not personalize, so decide stays shadowed on both sides of the cap.
    // The visitor limit itself is usage.overLimit, which is still false at exactly 10_000.
    const under = await decide(app, site, "vis-0");
    expect(under.status).toBe(200);
    const underBody = await under.json();
    expect(underBody.plan).toBe("shadow");
    expect(underBody.usage).toEqual({ visitors: SHADOW_CAP, visitorCap: SHADOW_CAP, overLimit: false });
    expect(counted()).toBe(SHADOW_CAP);

    insert.run("vis-over", site, now, now);
    expect(counted()).toBe(SHADOW_CAP + 1);

    const over = await decide(app, site, "vis-0");
    expect(over.status).toBe(200);
    const overBody = await over.json();
    expect(overBody.usage).toEqual({ visitors: SHADOW_CAP + 1, visitorCap: SHADOW_CAP, overLimit: true });
    expect(overBody.shadow).toBe(true);
    expect(overBody.decisions).toEqual([]);
  }, { timeout: 60_000 });
} else {
  test("isolated plan-limits child names a case", () => {
    throw new Error("PRISM_LIMIT_CASE must be site-cap or visitors");
  });
}

async function boot(plan: "growth" | "shadow"): Promise<{ app: App; db: import("bun:sqlite").Database }> {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-limits-")), "prism.db");
  process.env.ADMIN_TOKEN = ADMIN;
  process.env.DEMO_TOKEN = "unit-demo-token";
  process.env.READONLY_TOKENS = "";
  process.env.HOLDOUT_PCT = "0";
  process.env.PRISM_PLAN = plan;
  delete process.env.DEV_AUTH_EMAIL;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.SITE_WRITE_KEY;
  delete process.env.BASE_URL;
  const { default: app } = await import(`../../src/server.ts?isolate=plan-limits-${plan}`);
  const { db } = await import("../../src/db.ts");
  return { app, db };
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

function decide(app: App, site: string, visitorId: string) {
  return app.request("http://127.0.0.1/api/decide", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN}`,
      "fly-client-ip": "203.0.113.35",
    },
    body: JSON.stringify({ visitorId, site }),
  });
}
