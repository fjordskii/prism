import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreEnv, runFileIsolated, snapshotEnv, type EnvSnap } from "../support/isolated";

const ADMIN = "unit-admin-token";
let snap: EnvSnap | undefined;

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  beforeAll(() => {
    snap = snapshotEnv();
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });
  test("growth counts run in their own process", async () => {
    await runFileIsolated(join(import.meta.dir, "growth.test.ts"));
  }, { timeout: 60_000 });
} else {
  let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
  let db: import("bun:sqlite").Database;
  let makeSession: (email: string) => Promise<string>;
  let growth: typeof import("../../src/growth.ts");

  beforeAll(async () => {
    snap = snapshotEnv();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-growth-")), "prism.db");
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.DEMO_TOKEN = "unit-demo-token";
    process.env.READONLY_TOKENS = "unit-readonly-token";
    process.env.HOLDOUT_PCT = "0";
    process.env.GROWTH_RATE_PER_MIN = "3";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_ALLOWED_EMAILS;
    delete process.env.DEV_AUTH_EMAIL;
    delete process.env.DECIDE_RATE_PER_MIN;
    delete process.env.BILLING_MODE;
    delete process.env.PILOT_PAYMENT_LINK;
    delete process.env.BILLING_LIVE_APPROVED;
    ({ default: app } = await import("../../src/server.ts?isolate=growth"));
    ({ db } = await import("../../src/db.ts"));
    ({ makeSession } = await import("../../src/auth.ts"));
    growth = await import("../../src/growth.ts");
    const upsert = db.prepare("INSERT OR REPLACE INTO accounts (email, role, created_at) VALUES (?, ?, ?)");
    upsert.run("owner@prism.test", "owner", Date.now());
    upsert.run("editor@prism.test", "editor", Date.now());
    upsert.run("viewer@prism.test", "viewer", Date.now());
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM growth_events").get() as { n: number }).n;
  let ipN = 0;
  const ip = () => `198.51.100.${++ipN}`;

  function post(body: unknown, client = ip(), extra: Record<string, string> = {}) {
    return app.request("http://127.0.0.1/api/growth", {
      method: "POST",
      headers: { "content-type": "application/json", "fly-client-ip": client, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function read(path = "/api/growth", headers: Record<string, string> = {}) {
    return app.request("http://127.0.0.1" + path, { headers });
  }

  const admin = { authorization: `Bearer ${ADMIN}` };

  test("validation keeps only an allowlisted event, a short UTM, and a referrer host", () => {
    expect(growth.referrerHost("https://news.ycombinator.com/item?id=1&user=a@b.com")).toBe("news.ycombinator.com");
    expect(growth.referrerHost("https://user:pw@Example.com/path")).toBe("example.com");
    expect(growth.referrerHost("https://203.0.113.9/a")).toBe("");
    expect(growth.referrerHost("http://[::1]/")).toBe("");
    expect(growth.referrerHost("javascript:alert(1)")).toBe("");
    expect(growth.referrerHost("localhost")).toBe("localhost");
    expect(growth.referrerHost("x".repeat(3000))).toBe("");
    expect(growth.cleanUtm("  newsletter  ")).toBe("newsletter");
    expect(growth.cleanUtm("<script>oct")).toBe("scriptoct");
    expect(growth.cleanUtm("a".repeat(200))).toHaveLength(80);
    expect(growth.cleanUtm(12)).toBe("");
    expect(growth.isUtcDay("2024-02-29")).toBe(true);
    expect(growth.isUtcDay("2026-02-31")).toBe(false);
    expect(growth.parseGrowthBody({ event: "impression" }).ok).toBe(false);
    expect(growth.parseGrowthBody({ event: "landing_view" }).ok).toBe(true);
    expect(growth.parseGrowthBody(["landing_view"]).ok).toBe(false);
    const range = growth.growthRange("2026-10-03", "2026-10-01");
    expect(range.ok).toBe(false);
  });

  test("aggregation sums a day and keeps the UTM breakdown", () => {
    const report = growth.growthReport([
      { event: "landing_view", day: "2026-10-12", source: "newsletter", medium: "email", campaign: "oct", referrerHost: "mail.google.com", count: 3 },
      { event: "landing_view", day: "2026-10-12", source: "", medium: "", campaign: "", referrerHost: "", count: 1 },
      { event: "pilot_cta", day: "2026-10-12", source: "newsletter", medium: "email", campaign: "oct", referrerHost: "t.co", count: 2 },
      { event: "landing_view", day: "2026-09-01", source: "old", medium: "email", campaign: "sept", referrerHost: "", count: 9 },
    ], "2026-10-01", "2026-10-12");
    expect(report.from).toBe("2026-10-01");
    expect(report.to).toBe("2026-10-12");
    expect(report.days.map((day) => day.day)).toEqual(["2026-10-12"]);
    expect(report.days[0]!.events.landing_view!.count).toBe(4);
    expect(report.days[0]!.events.landing_view!.utm).toEqual([
      { source: "newsletter", medium: "email", campaign: "oct", referrerHost: "mail.google.com", count: 3 },
      { source: "", medium: "", campaign: "", referrerHost: "", count: 1 },
    ]);
    expect(report.days[0]!.events.pilot_cta!.count).toBe(2);
  });

  test("the growth table has no IP, visitor, or cookie column", () => {
    const cols = db.prepare("PRAGMA table_info(growth_events)").all() as { name: string }[];
    const names = cols.map((col) => col.name);
    expect(names).toEqual(["id", "event", "day", "utm_source", "utm_medium", "utm_campaign", "referrer_host", "ts"]);
    expect(names.join(" ")).not.toMatch(/ip|visitor|cookie/i);
  });

  test("a valid count stores the host and UTM, sets no cookie, and leaves personalization tables alone", async () => {
    const beforeEvents = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const beforeVisitors = (db.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n;
    const before = rows();
    const res = await post({
      event: " landing_view ",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "oct",
      referrer: "https://news.ycombinator.com/item?id=1&user=a@b.com",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
    expect(rows()).toBe(before + 1);
    const row = db.prepare(
      "SELECT event, utm_source, utm_medium, utm_campaign, referrer_host FROM growth_events WHERE utm_campaign = ?"
    ).get("oct") as { event: string; utm_source: string; utm_medium: string; utm_campaign: string; referrer_host: string };
    expect(row).toEqual({
      event: "landing_view",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "oct",
      referrer_host: "news.ycombinator.com",
    });
    expect(row.referrer_host).not.toContain("item");
    expect(row.referrer_host).not.toContain("@");
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(beforeEvents);
    expect((db.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n).toBe(beforeVisitors);
  });

  test("an unknown event, bad JSON, an IP referrer, and an oversized body store nothing", async () => {
    const before = rows();
    const unknown = await post({ event: "impression" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "invalid" });
    const junk = await post("{not json");
    expect(junk.status).toBe(400);
    const dropped = await post({ event: "pilot_cta", referrer: "https://203.0.113.9/secret" });
    expect(dropped.status).toBe(204);
    const stored = db.prepare("SELECT referrer_host FROM growth_events WHERE event = ? ORDER BY id DESC").get("pilot_cta") as { referrer_host: string };
    expect(stored.referrer_host).toBe("");
    const big = "x".repeat(growth.GROWTH_BODY_MAX + 1);
    const oversized = await post(big);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "too_large" });
    const injection = await post({ event: "landing_view'; DROP TABLE growth_events;--" });
    expect(injection.status).toBe(400);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'growth_events'").get()).toEqual({ name: "growth_events" });
    expect(rows()).toBe(before + 1);
  });

  test("UTM on the referer is kept when the body omits it, and the body wins when both are set", async () => {
    const fromHeader = await post({ event: "snippet_copy" }, ip(), {
      referer: "https://example.com/landing?utm_source=partner&utm_medium=social&utm_campaign=launch",
    });
    expect(fromHeader.status).toBe(204);
    const headerRow = db.prepare(
      "SELECT utm_source, utm_medium, utm_campaign, referrer_host FROM growth_events WHERE utm_campaign = ?"
    ).get("launch") as { utm_source: string; utm_medium: string; utm_campaign: string; referrer_host: string };
    expect(headerRow).toEqual({ utm_source: "partner", utm_medium: "social", utm_campaign: "launch", referrer_host: "" });

    const both = await post(
      { event: "snippet_copy", utm_source: "newsletter", utm_medium: "email", utm_campaign: "body-wins", referrer: "https://t.co/abc" },
      ip(),
      { referer: "https://example.com/?utm_source=partner&utm_medium=social&utm_campaign=ignored" },
    );
    expect(both.status).toBe(204);
    const bodyRow = db.prepare(
      "SELECT utm_source, utm_medium, utm_campaign, referrer_host FROM growth_events WHERE utm_campaign = ?"
    ).get("body-wins");
    expect(bodyRow).toEqual({
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "body-wins",
      referrer_host: "t.co",
    });
  });

  test("two identical counts add up in one UTM bucket", async () => {
    const client = ip();
    const today = growth.utcDay(Date.now());
    expect((await post({ event: "snippet_copy", utm_source: "ads", utm_medium: "cpc", utm_campaign: "bucket", referrer: "https://ads.example/a" }, client)).status).toBe(204);
    expect((await post({ event: "snippet_copy", utm_source: "ads", utm_medium: "cpc", utm_campaign: "bucket", referrer: "https://ads.example/b" }, client)).status).toBe(204);
    const body = await (await read(`/api/growth?from=${today}&to=${today}`, admin)).json();
    const bucket = body.days.flatMap((day: { events: Record<string, { utm: { campaign: string; count: number }[] }> }) => day.events.snippet_copy?.utm ?? []).find((row: { campaign: string }) => row.campaign === "bucket");
    expect(bucket).toEqual({ source: "ads", medium: "cpc", campaign: "bucket", referrerHost: "ads.example", count: 2 });
  });

  test("the per-client cap matches the decide window: extra counts are 429 and not stored", async () => {
    const client = ip();
    const before = rows();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await post({ event: "pilot_view", utm_campaign: "capped" }, client);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    expect(rows()).toBe(before + 3);
    const other = await post({ event: "pilot_view", utm_campaign: "other-client" }, ip());
    expect(other.status).toBe(204);
    expect(rows()).toBe(before + 4);
  });

  test("the read is 401 without an admin token or owner session", async () => {
    const open = await read();
    expect(open.status).toBe(401);
    expect(await open.json()).toEqual({ error: "unauthorized" });

    const cases: Record<string, string>[] = [
      { authorization: "Bearer wrong" },
      { authorization: "Bearer unit-demo-token" },
      { authorization: "Bearer unit-readonly-token" },
      { cookie: `prism_session=${await makeSession("editor@prism.test")}` },
      { cookie: `prism_session=${await makeSession("viewer@prism.test")}` },
    ];
    for (const headers of cases) {
      const res = await read("/api/growth?from=2026-10-01&to=2026-10-12", headers);
      expect(res.status).toBe(401);
    }
  });

  test("an admin token or owner session gets daily counts filtered by date, with the UTM breakdown", async () => {
    const insert = db.prepare(
      `INSERT INTO growth_events (event, day, utm_source, utm_medium, utm_campaign, referrer_host, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run("landing_view", "2026-10-01", "newsletter", "email", "oct", "mail.google.com", Date.parse("2026-10-01T12:00:00Z"));
    insert.run("landing_view", "2026-10-01", "", "", "", "", Date.parse("2026-10-01T13:00:00Z"));
    insert.run("pilot_cta", "2026-10-02", "newsletter", "email", "oct", "t.co", Date.parse("2026-10-02T12:00:00Z"));
    insert.run("landing_view", "2026-09-01", "old", "email", "sept", "", Date.parse("2026-09-01T12:00:00Z"));

    const res = await read("/api/growth?from=2026-10-01&to=2026-10-02", admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBe("2026-10-01");
    expect(body.to).toBe("2026-10-02");
    expect(body.days.map((day: { day: string }) => day.day)).toEqual(["2026-10-01", "2026-10-02"]);
    const first = body.days[0].events.landing_view;
    expect(first.count).toBe(2);
    expect(first.utm).toEqual([
      { source: "", medium: "", campaign: "", referrerHost: "", count: 1 },
      { source: "newsletter", medium: "email", campaign: "oct", referrerHost: "mail.google.com", count: 1 },
    ]);
    expect(body.days[1].events.pilot_cta).toEqual({
      count: 1,
      utm: [{ source: "newsletter", medium: "email", campaign: "oct", referrerHost: "t.co", count: 1 }],
    });
    expect(JSON.stringify(body)).not.toContain("2026-09-01");

    const owner = await read("/api/growth?from=2026-10-02&to=2026-10-02", {
      cookie: `prism_session=${await makeSession("owner@prism.test")}`,
    });
    expect(owner.status).toBe(200);
    const ownerBody = await owner.json();
    expect(ownerBody.days).toHaveLength(1);
    expect(ownerBody.days[0].events.pilot_cta.count).toBe(1);

    const byQuery = await read(`/api/growth?from=2026-10-02&to=2026-10-02&token=${ADMIN}`);
    expect(byQuery.status).toBe(200);

    const bad = await read("/api/growth?from=2026-10-03&to=2026-10-01", admin);
    expect(bad.status).toBe(400);
    const impossible = await read("/api/growth?from=2026-02-31&to=2026-03-01", admin);
    expect(impossible.status).toBe(400);
    const leap = await read("/api/growth?from=2024-02-29&to=2024-02-29", admin);
    expect(leap.status).toBe(200);
    expect((await leap.json()).days).toEqual([]);
  });

  test("the default range is the last 90 UTC days and drops an older row", async () => {
    const oldDay = growth.utcDay(Date.now() - 200 * 86_400_000);
    db.prepare(
      `INSERT INTO growth_events (event, day, utm_source, utm_medium, utm_campaign, referrer_host, ts)
       VALUES ('landing_view', ?, 'old', 'email', 'ancient', '', ?)`
    ).run(oldDay, Date.now() - 200 * 86_400_000);
    const res = await read("/api/growth", admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from <= growth.utcDay(Date.now())).toBe(true);
    expect(body.to).toBe(growth.utcDay(Date.now()));
    expect(JSON.stringify(body)).not.toContain(oldDay);
    expect(JSON.stringify(body)).toContain(growth.utcDay(Date.now()));
  });

  test("a valid inquiry is counted once, and an invalid one is not", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE event = 'pilot_inquiry'").get() as { n: number }).n;
    const ok = await app.request("http://127.0.0.1/api/pilot/inquiry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "fly-client-ip": ip(),
        referer: "https://prism.test/pilot?utm_source=ignored&utm_medium=social&utm_campaign=from-header",
      },
      body: JSON.stringify({
        email: "buyer@shop.example",
        storeUrl: "https://shop.example",
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "inquiry-oct",
        referrer: "https://news.ycombinator.com/item?id=9",
      }),
    });
    expect(ok.status).toBe(200);
    const bad = await app.request("http://127.0.0.1/api/pilot/inquiry", {
      method: "POST",
      headers: { "content-type": "application/json", "fly-client-ip": ip() },
      body: JSON.stringify({ email: "not-an-email", storeUrl: "https://shop.example" }),
    });
    expect(bad.status).toBe(400);
    const counted = db.prepare(
      "SELECT utm_source, utm_medium, utm_campaign, referrer_host FROM growth_events WHERE event = 'pilot_inquiry' AND utm_campaign = ?"
    ).all("inquiry-oct");
    expect(counted).toEqual([
      { utm_source: "newsletter", utm_medium: "email", utm_campaign: "inquiry-oct", referrer_host: "news.ycombinator.com" },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM growth_events WHERE event = 'pilot_inquiry'").get() as { n: number }).n).toBe(before + 1);

    const fromReferer = await app.request("http://127.0.0.1/api/pilot/inquiry", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "fly-client-ip": ip(),
        referer: "https://news.example/out?utm_source=partner&utm_medium=social&utm_campaign=form-header",
      },
      body: new URLSearchParams({ email: "form@shop.example", storeUrl: "https://form.example" }).toString(),
    });
    expect(fromReferer.status).toBe(200);
    const formRow = db.prepare(
      "SELECT utm_source, utm_medium, utm_campaign, referrer_host FROM growth_events WHERE utm_campaign = ?"
    ).get("form-header");
    expect(formRow).toEqual({ utm_source: "partner", utm_medium: "social", utm_campaign: "form-header", referrer_host: "" });
  });

  test("the landing page and /pilot send the allowlisted events and leave the pilot links in place", async () => {
    const landing = await (await app.request("http://127.0.0.1/")).text();
    expect(landing).toContain('send("landing_view")');
    expect(landing).toContain('send("pilot_cta")');
    expect(landing).toContain('send("snippet_copy")');
    expect(landing).toContain('"/api/growth"');
    expect(landing).toContain('id="copySnippet"');
    expect(landing).toContain('href="/pilot"');
    const section = landing.match(/<section id="pricing"[\s\S]*?<\/section>/)?.[0] ?? "";
    const hrefs = [...section.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual(["/pilot", "/pilot", "/pilot", "mailto:hello@sundaymorning.software"]);

    const landingAlias = await (await app.request("http://127.0.0.1/landing/")).text();
    expect(landingAlias).toContain('send("landing_view")');

    const pilot = await (await app.request("http://127.0.0.1/pilot")).text();
    expect(pilot).toContain('send("pilot_view")');
    expect(pilot).toContain('name="utm_source"');
    expect(pilot).toContain('name="utm_campaign"');
    expect(pilot).toContain('name="referrer"');
    expect(pilot).toContain("Try Prism on your Shopify store");
    expect(pilot).not.toContain('send("pilot_cta")');

    const thanks = await (await app.request("http://127.0.0.1/pilot/thanks")).text();
    expect(thanks).not.toContain("pilot_view");

    const privacy = await (await app.request("http://127.0.0.1/privacy")).text();
    expect(privacy).toContain("The saved count has no cookie and no IP address.");
  });
}
