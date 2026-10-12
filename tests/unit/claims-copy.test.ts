import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreEnv, runFileIsolated, snapshotEnv, type EnvSnap } from "../support/isolated";

let snap: EnvSnap | undefined;

const HOLD = [
  "Each audience gets its own control group",
  "You set the holdout share for each site",
  "Sends more traffic to winners within each audience",
  "Your day-30 report shows lift for each audience",
  "The holdout is kept per audience",
];

const STALE = [
  "99.9%",
  "$79",
  "$179",
  "Lighthouse",
  "automatically, per segment",
  "winners per segment",
  "applied automatically",
  "Free until it proves itself",
];

function assertClean(html: string) {
  for (const phrase of [...STALE, ...HOLD]) expect(html).not.toContain(phrase);
  expect(html.replaceAll("$299/mo", "")).not.toContain("$299");
}

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  beforeAll(() => {
    snap = snapshotEnv();
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });
  test("claims copy runs in its own process", async () => {
    await runFileIsolated(join(import.meta.dir, "claims-copy.test.ts"));
  }, { timeout: 60_000 });
} else {
  let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

  beforeAll(async () => {
    snap = snapshotEnv();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-claims-")), "prism.db");
    process.env.ADMIN_TOKEN = "unit-admin-token";
    process.env.DEMO_TOKEN = "unit-demo-token";
    process.env.HOLDOUT_PCT = "0";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.DEV_AUTH_EMAIL;
    delete process.env.BILLING_MODE;
    delete process.env.PILOT_PAYMENT_LINK;
    ({ default: app } = await import("../../src/server.ts?isolate=claims-copy"));
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  test("the landing file has the offer marker and none of the retired prices", () => {
    const html = readFileSync(join(import.meta.dir, "../../landing/index.html"), "utf8");
    expect(html).toContain("<!-- prism:offers -->");
    expect(html).toContain("Start with a pilot");
    expect(html).toContain("Personalization with a control group built in.");
    expect(html).not.toContain("$750");
    expect(html).not.toContain("$299/mo");
    assertClean(html);
  });

  test("rendered / and /terms drop the SLA and old tiers and keep the pilot offer", async () => {
    const home = await (await app.request("http://127.0.0.1/")).text();
    const terms = await (await app.request("http://127.0.0.1/terms")).text();

    assertClean(home);
    assertClean(terms);

    expect(home).toContain("Start with a pilot");
    expect(home).toContain("Free for the first 5 stores.");
    expect(home).toContain("$750 flat for 30 days.");
    expect(home).toContain("Ongoing management is $299/mo, month to month.");
    expect(home).toContain("if anything fails your visitors see your normal page");
    expect(home).not.toContain("no network call");

    expect(terms).toContain("Discovery (free for the first 5 stores)");
    expect(terms).toContain("$750 flat for 30 days");
    expect(terms).toContain("Retain ($299/mo, month to month)");
    expect(terms).toContain("don't offer an uptime guarantee or service credits during the pilot");
    expect(terms).toContain("The snippet fails open");
  });
}
