import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreEnv, runFileIsolated, snapshotEnv, type EnvSnap } from "../support/isolated";
import { billingDecision } from "../../src/offer";

const ADMIN = "unit-admin-token";
const TEST_LINK = "https://buy.stripe.com/test_unit_mock";
const LIVE_LINK = "https://buy.stripe.com/c/pay/cs_live_mock";
let snap: EnvSnap | undefined;

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  beforeAll(() => {
    snap = snapshotEnv();
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });
  test("pilot billing runs in its own process", async () => {
    await runFileIsolated(join(import.meta.dir, "billing.test.ts"));
  }, { timeout: 60_000 });
} else {
  let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
  let ownerCookie = "";
  let editorCookie = "";

  beforeAll(async () => {
    snap = snapshotEnv();
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-billing-")), "prism.db");
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.DEMO_TOKEN = "unit-demo-token";
    process.env.HOLDOUT_PCT = "0";
    delete process.env.SESSION_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.DEV_AUTH_EMAIL;
    delete process.env.BILLING_MODE;
    delete process.env.PILOT_PAYMENT_LINK;
    delete process.env.BILLING_LIVE_APPROVED;
    ({ default: app } = await import("../../src/server.ts?isolate=billing"));
    const { db } = await import("../../src/db.ts");
    const { makeSession } = await import("../../src/auth.ts");
    const upsert = db.prepare("INSERT OR REPLACE INTO accounts (email, role, created_at) VALUES (?, ?, ?)");
    upsert.run("owner@prism.test", "owner", Date.now());
    upsert.run("editor@prism.test", "editor", Date.now());
    ownerCookie = `prism_session=${await makeSession("owner@prism.test")}`;
    editorCookie = `prism_session=${await makeSession("editor@prism.test")}`;
  });
  afterEach(() => {
    delete process.env.BILLING_MODE;
    delete process.env.PILOT_PAYMENT_LINK;
    delete process.env.BILLING_LIVE_APPROVED;
  });
  afterAll(() => {
    if (snap) restoreEnv(snap);
  });

  const offerSentences = [
    "Free for the first 5 stores.",
    "$750 flat for 30 days.",
    "Full refund if setup or the day 30 report is not delivered.",
    "There is no lift guarantee.",
    "Orders and revenue are tracked.",
    "Ongoing management is $299/mo, month to month.",
  ];

  function get(path: string, headers: Record<string, string> = {}) {
    return app.request("http://127.0.0.1" + path, { headers });
  }

  async function body(path: string, headers: Record<string, string> = {}) {
    const res = await get(path, headers);
    expect(res.status).toBe(200);
    return res.text();
  }

  test("billingDecision stays off until the mode and the link agree", () => {
    expect(billingDecision({})).toEqual({ mode: "off", effectiveMode: "off", paymentLink: null, payAudience: "nobody" });
    expect(billingDecision({ BILLING_MODE: "off", PILOT_PAYMENT_LINK: TEST_LINK })).toEqual({
      mode: "off", effectiveMode: "off", paymentLink: null, payAudience: "nobody",
    });
    expect(billingDecision({ BILLING_MODE: "test", PILOT_PAYMENT_LINK: TEST_LINK })).toEqual({
      mode: "test", effectiveMode: "test", paymentLink: TEST_LINK, payAudience: "operator",
    });
    expect(billingDecision({ BILLING_MODE: "test", PILOT_PAYMENT_LINK: LIVE_LINK })).toEqual({
      mode: "test", effectiveMode: "off", paymentLink: null, payAudience: "nobody",
    });
    expect(billingDecision({ BILLING_MODE: "live", PILOT_PAYMENT_LINK: LIVE_LINK })).toEqual({
      mode: "live", effectiveMode: "off", paymentLink: null, payAudience: "nobody",
    });
    expect(billingDecision({ BILLING_MODE: "live", PILOT_PAYMENT_LINK: LIVE_LINK, BILLING_LIVE_APPROVED: "yes" })).toEqual({
      mode: "live", effectiveMode: "live", paymentLink: LIVE_LINK, payAudience: "everyone",
    });
    expect(billingDecision({ BILLING_MODE: "live", PILOT_PAYMENT_LINK: TEST_LINK, BILLING_LIVE_APPROVED: "yes" })).toEqual({
      mode: "live", effectiveMode: "off", paymentLink: null, payAudience: "nobody",
    });
  });

  test("the landing file has the offer marker and none of the prices", () => {
    const html = readFileSync(join(import.meta.dir, "../../landing/index.html"), "utf8");
    expect(html).toContain("<!-- prism:offers -->");
    expect(html).not.toContain("$750");
    expect(html).not.toContain("$299/mo");
    expect(html).not.toContain("Pay for the pilot");
  });

  test("off mode renders the offers, hides the pay button, and still accepts an inquiry", async () => {
    for (const path of ["/pilot", "/", "/landing/"]) {
      const html = await body(path);
      for (const sentence of offerSentences) expect(html).toContain(sentence);
      expect(html).not.toContain("Pay for the pilot");
      expect(html).not.toContain("buy.stripe.com");
    }

    const open = await get("/api/pilot/billing-status");
    expect(open.status).toBe(401);
    expect(await open.json()).toEqual({ error: "unauthorized" });
    const editor = await get("/api/pilot/billing-status", { cookie: editorCookie });
    expect(editor.status).toBe(401);
    const owner = await get("/api/pilot/billing-status", { cookie: ownerCookie });
    expect(await owner.json()).toEqual({ mode: "off", effectiveMode: "off", priceShown: false });
    const admin = await get("/api/pilot/billing-status", { authorization: `Bearer ${ADMIN}` });
    expect(await admin.json()).toEqual({ mode: "off", effectiveMode: "off", priceShown: false });

    const thanks = await body("/pilot/thanks");
    expect(thanks).toContain("Payment received. We'll email you to schedule the install.");
    expect(thanks).not.toContain("Pay for the pilot");
    expect(thanks).not.toContain("<form");

    const inquiry = await app.request("http://127.0.0.1/api/pilot/inquiry", {
      method: "POST",
      headers: { "content-type": "application/json", "fly-client-ip": "203.0.113.40" },
      body: JSON.stringify({ email: "off@shop.example", storeUrl: "https://shop.example" }),
    });
    expect(inquiry.status).toBe(200);
    expect(await inquiry.json()).toEqual({ ok: true });
  });

  test("test mode with a non-test link logs an error and behaves as off", async () => {
    const errors = capture();
    process.env.BILLING_MODE = "test";
    process.env.PILOT_PAYMENT_LINK = LIVE_LINK;
    try {
      const html = await body("/pilot", { cookie: ownerCookie });
      expect(html).not.toContain("Pay for the pilot");
      expect(html).not.toContain(LIVE_LINK);
      expect(html).toContain("$750 flat for 30 days.");
      const status = await get("/api/pilot/billing-status", { authorization: `Bearer ${ADMIN}` });
      expect(await status.json()).toEqual({ mode: "test", effectiveMode: "off", priceShown: false });
      expect(errors()).toContain("billing: BILLING_MODE=test requires PILOT_PAYMENT_LINK to start with https://buy.stripe.com/test_");
    } finally {
      errors.restore();
    }
  });

  test("test mode shows the pay button only to an owner session", async () => {
    process.env.BILLING_MODE = "test";
    process.env.PILOT_PAYMENT_LINK = TEST_LINK;

    for (const headers of [{}, { cookie: editorCookie }, { authorization: `Bearer ${ADMIN}` }] as const) {
      for (const path of ["/pilot", "/"]) {
        const html = await body(path, headers);
        expect(html).not.toContain("Pay for the pilot");
        expect(html).not.toContain(TEST_LINK);
        expect(html).toContain("Free for the first 5 stores.");
      }
    }

    for (const path of ["/pilot", "/"]) {
      const html = await body(path, { cookie: ownerCookie });
      expect(html).toContain(`href="${TEST_LINK}"`);
      expect(html).toContain("Pay for the pilot");
    }

    const owner = await get("/api/pilot/billing-status", { cookie: ownerCookie });
    expect(await owner.json()).toEqual({ mode: "test", effectiveMode: "test", priceShown: true });
    const token = await get("/api/pilot/billing-status", { authorization: `Bearer ${ADMIN}` });
    expect(await token.json()).toEqual({ mode: "test", effectiveMode: "test", priceShown: false });
    const anon = await get("/api/pilot/billing-status");
    expect(anon.status).toBe(401);
  });

  test("a test link that breaks out of the href is escaped", async () => {
    process.env.BILLING_MODE = "test";
    process.env.PILOT_PAYMENT_LINK = 'https://buy.stripe.com/test_abc"onclick="alert(1)';
    const html = await body("/pilot", { cookie: ownerCookie });
    expect(html).toContain("https://buy.stripe.com/test_abc&quot;onclick=&quot;alert(1)");
    expect(html).not.toContain('onclick="alert(1)"');
  });

  test("live mode without approval logs an error and behaves as off", async () => {
    const errors = capture();
    process.env.BILLING_MODE = "live";
    process.env.PILOT_PAYMENT_LINK = LIVE_LINK;
    try {
      const html = await body("/", { cookie: ownerCookie });
      expect(html).not.toContain("Pay for the pilot");
      expect(html).toContain("Ongoing management is $299/mo, month to month.");
      const status = await get("/api/pilot/billing-status", { cookie: ownerCookie });
      expect(await status.json()).toEqual({ mode: "live", effectiveMode: "off", priceShown: false });
      expect(errors()).toContain("billing: BILLING_MODE=live requires BILLING_LIVE_APPROVED=yes and a live https://buy.stripe.com Payment Link");
    } finally {
      errors.restore();
    }
  });

  test("approved live mode shows the pay button to a logged-out visitor", async () => {
    process.env.BILLING_MODE = "live";
    process.env.PILOT_PAYMENT_LINK = LIVE_LINK;
    process.env.BILLING_LIVE_APPROVED = "yes";
    const html = await body("/pilot");
    expect(html).toContain(`href="${LIVE_LINK}"`);
    expect(html).toContain("Pay for the pilot");
    expect(html).toContain(">Send<");
    const status = await get("/api/pilot/billing-status", { authorization: `Bearer ${ADMIN}` });
    expect(await status.json()).toEqual({ mode: "live", effectiveMode: "live", priceShown: true });
  });
}

function capture() {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return Object.assign(() => lines, { restore: () => { console.error = orig; } });
}
