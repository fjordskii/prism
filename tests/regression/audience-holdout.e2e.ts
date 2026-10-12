import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { audienceKey, isHoldout } from "../../src/holdout";
import { ADMIN_TOKEN, DEMO_TOKEN } from "../support/env.ts";
import { api, horizontalOverflow } from "../support/helpers.ts";

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const giftAudience = JSON.stringify([{ field: "intent", op: "eq", value: "gift" }]);
const bundleAudience = JSON.stringify([{ field: "cartItems", op: "gte", value: 3 }]);

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createVariant(baseUrl: string, site: string, name: string, audience: string) {
  const created = await api(baseUrl, "/api/variants", {
    method: "POST",
    headers: auth(ADMIN_TOKEN),
    json: { site, name, selector: "#hero", ops: "[]", audience },
  });
  expect(created.status).toBe(201);
  return created.body.id as number;
}

function visitorFor(key: string, pct: number, wantHoldout: boolean, salt: string) {
  for (let i = 0; i < 5000; i++) {
    const id = `${salt}_${i}`;
    if (isHoldout(id, "#hero", key, pct) === wantHoldout) return id;
  }
  throw new Error("no visitor for " + salt);
}

describe("regression: per-audience holdout", { tags: ["regression"] }, () => {
  test("two audiences on one selector keep separate control arms and readouts", async ({ app, screen, browser }) => {
    const site = uid("aud");
    const other = uid("other");
    const giftId = await createVariant(app.baseUrl!, site, "Gift hero", giftAudience);
    const bundleId = await createVariant(app.baseUrl!, site, "Bundle hero", bundleAudience);
    await createVariant(app.baseUrl!, other, "Other site hero", giftAudience);

    const set = await api(app.baseUrl!, `/api/sites/${site}/holdout`, {
      method: "POST",
      headers: auth(ADMIN_TOKEN),
      json: { holdoutPct: 30 },
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ok: true, site, holdoutPct: 30, holdoutPctSource: "site" });

    const giftKey = audienceKey(giftAudience);
    const bundleKey = audienceKey(bundleAudience);
    const giftControl = visitorFor(giftKey, 30, true, "giftc");
    const giftTreat = visitorFor(giftKey, 30, false, "giftt");
    const bundleControl = visitorFor(bundleKey, 30, true, "bundc");

    async function decide(visitorId: string, traits: Record<string, unknown>) {
      await api(app.baseUrl!, "/api/identify", { method: "POST", json: { visitorId, site, traits } });
      const first = await api(app.baseUrl!, "/api/decide", { method: "POST", json: { visitorId, site } });
      const second = await api(app.baseUrl!, "/api/decide", { method: "POST", json: { visitorId, site } });
      expect(first.status).toBe(200);
      expect(second.body.decisions).toEqual(first.body.decisions);
      expect(first.body.decisions).toHaveLength(1);
      return first.body.decisions[0];
    }

    const held = await decide(giftControl, { intent: "gift" });
    expect(held).toEqual(expect.objectContaining({ selector: "#hero", variantId: null, control: true, audienceKey: giftKey }));
    const shown = await decide(giftTreat, { intent: "gift" });
    expect(shown).toEqual(expect.objectContaining({ selector: "#hero", variantId: giftId, audienceKey: giftKey }));
    const bundleHeld = await decide(bundleControl, { cartItems: 4 });
    expect(bundleHeld).toEqual(expect.objectContaining({ selector: "#hero", variantId: null, control: true, audienceKey: bundleKey }));

    const overlapId = "overlap_" + uid("v");
    const overlap = await decide(overlapId, { intent: "gift", cartItems: 4 });
    expect([giftKey, bundleKey]).toContain(overlap.audienceKey);
    expect(overlap.selector).toBe("#hero");

    async function track(visitorId: string, decision: { variantId: number | null; audienceKey: string }, type: string) {
      const posted = await api(app.baseUrl!, "/api/events", {
        method: "POST",
        json: {
          site,
          visitorId,
          events: [{ type, variantId: decision.variantId, selector: "#hero", audienceKey: decision.audienceKey }],
        },
      });
      expect(posted.body.recorded).toBe(1);
    }

    await track(giftControl, held, "impression");
    await track(giftTreat, shown, "impression");
    await track(giftTreat, shown, "conversion");
    await track(bundleControl, bundleHeld, "impression");

    const giftOrder = await api(app.baseUrl!, "/api/events", {
      method: "POST",
      json: { site, visitorId: giftTreat, events: [{ type: "order", orderId: "ord_gift", value: "24.00", currency: "USD" }] },
    });
    expect(giftOrder.body.recorded).toBe(1);
    const bundleOrder = await api(app.baseUrl!, "/api/events", {
      method: "POST",
      json: { site, visitorId: bundleControl, events: [{ type: "order", orderId: "ord_bundle", value: "10.00", currency: "USD" }] },
    });
    expect(bundleOrder.body.recorded).toBe(1);

    // An older event with no audience stays in the pooled row only.
    await api(app.baseUrl!, "/api/events", {
      method: "POST",
      json: { site, visitorId: uid("legacy"), events: [{ type: "impression", variantId: null, selector: "#hero" }] },
    });

    const stats = await api(app.baseUrl!, `/api/stats?site=${site}`, { headers: auth(ADMIN_TOKEN) });
    expect(stats.status).toBe(200);
    expect(stats.body.holdoutPct).toBe(30);
    expect(stats.body.holdoutPctSource).toBe("site");
    const experiences = stats.body.experiences as {
      audienceKey: string;
      treated: { impressions: number; conversions: number; orders: number };
      control: { impressions: number; conversions: number; orders: number };
      metrics: { key: string; status: string; text: string; ci95: [number, number] | null }[];
      daysUntilReadable: number | null;
    }[];
    const giftExp = experiences.find((e) => e.audienceKey === giftKey)!;
    const bundleExp = experiences.find((e) => e.audienceKey === bundleKey)!;
    expect(giftExp.treated.impressions).toBe(1);
    expect(giftExp.treated.conversions).toBe(1);
    expect(giftExp.treated.orders).toBe(1);
    expect(giftExp.control.impressions).toBe(1);
    expect(giftExp.control.orders).toBe(0);
    expect(bundleExp.control.impressions).toBe(1);
    expect(bundleExp.control.orders).toBe(1);
    expect(bundleExp.treated.impressions).toBe(0);
    expect(bundleExp.treated.orders).toBe(0);
    expect(stats.body.control.impressions).toBe(3);
    expect(JSON.stringify(stats.body)).not.toContain("Other site hero");
    const clicks = giftExp.metrics.find((m) => m.key === "click_rate")!;
    expect(clicks.status).toBe("not_enough_data");
    expect(clicks.text).toContain("Not enough data yet");
    expect(clicks.text.toLowerCase()).not.toContain("win");
    expect(giftExp.daysUntilReadable).toBeGreaterThan(0);
    for (const key of ["orders_per_visitor", "rpv:USD", "aov:USD"]) {
      const metric = giftExp.metrics.find((m) => m.key === key);
      expect(metric, key).toBeTruthy();
      expect(metric!.text.toLowerCase()).not.toContain("win");
    }

    const otherStats = await api(app.baseUrl!, `/api/stats?site=${other}`, { headers: auth(ADMIN_TOKEN) });
    expect(otherStats.body.experiences.find((e: { names: string[] }) => e.names?.includes?.("Gift hero"))).toBeUndefined();

    await app.open(`/admin?token=${ADMIN_TOKEN}&site=${site}`);
    await expect(screen.getByRole("heading", "Audience holdouts", { level: 2 })).toBeVisible();
    await expect(screen.getByText("Not enough data yet", { exact: false }).first()).toBeVisible();
    await expect(screen.getByRole("cell", "Control (holdout)")).toBeVisible();
    expect(await horizontalOverflow(browser)).toBeLessThanOrEqual(0);
    void bundleId;
  });

  test("a site can set its own holdout without changing the deployment default", async ({ app }) => {
    const heldSite = uid("held");
    const openSite = uid("open");
    await createVariant(app.baseUrl!, heldSite, "Held hero", "[]");
    await createVariant(app.baseUrl!, openSite, "Open hero", "[]");

    const saved = await api(app.baseUrl!, `/api/sites/${heldSite}/holdout`, {
      method: "POST",
      headers: auth(ADMIN_TOKEN),
      json: { holdoutPct: 100 },
    });
    expect(saved.body.holdoutPct).toBe(100);

    const denied = await api(app.baseUrl!, `/api/sites/${heldSite}/holdout`, {
      method: "POST",
      headers: auth(DEMO_TOKEN),
      json: { holdoutPct: 0 },
    });
    expect(denied.status).toBe(403);

    for (let i = 0; i < 5; i++) {
      const held = await api(app.baseUrl!, "/api/decide", { method: "POST", json: { visitorId: `h${i}`, site: heldSite } });
      expect(held.body.decisions[0].control).toBe(true);
      const open = await api(app.baseUrl!, "/api/decide", { method: "POST", json: { visitorId: `o${i}`, site: openSite } });
      expect(open.body.decisions[0].variantId).toEqual(expect.any(Number));
      expect(open.body.decisions[0].control).toBeUndefined();
    }

    const cleared = await api(app.baseUrl!, `/api/sites/${heldSite}/holdout`, {
      method: "POST",
      headers: auth(ADMIN_TOKEN),
      json: { holdoutPct: null },
    });
    expect(cleared.body).toEqual({ ok: true, site: heldSite, holdoutPct: 0, holdoutPctSource: "default" });
    const after = await api(app.baseUrl!, "/api/decide", { method: "POST", json: { visitorId: "after", site: heldSite } });
    expect(after.body.decisions[0].variantId).toEqual(expect.any(Number));
  });

  test("the lift report is limited to one site and to an admin token or owner session", async ({ app }) => {
    const site = uid("rep");
    const other = uid("repb");
    await createVariant(app.baseUrl!, site, "Report hero", giftAudience);
    await createVariant(app.baseUrl!, other, "Secret other hero", giftAudience);

    const missing = await api(app.baseUrl!, `/api/sites/${site}/lift-report`);
    expect(missing.status).toBe(401);
    const demo = await api(app.baseUrl!, `/api/sites/${site}/lift-report`, { headers: auth(DEMO_TOKEN) });
    expect(demo.status).toBe(403);
    const demoOther = await api(app.baseUrl!, `/api/sites/demo/lift-report`, { headers: auth(DEMO_TOKEN) });
    expect(demoOther.status).toBe(403);
    const junk = await api(app.baseUrl!, `/api/sites/${site}/lift-report`, { headers: auth("not-a-real-token") });
    expect(junk.status).toBe(401);

    const json = await api(app.baseUrl!, `/api/sites/${site}/lift-report`, { headers: auth(ADMIN_TOKEN) });
    expect(json.status).toBe(200);
    expect(json.body.site).toBe(site);
    expect(JSON.stringify(json.body)).not.toContain("Secret other hero");
    expect(JSON.stringify(json.body)).toContain("Report hero");
    expect(json.body.note).toContain("same audience");
    expect(json.body.experiences.length).toBeGreaterThan(0);

    const html = await fetch(new URL(`/api/sites/${site}/lift-report?format=html`, app.baseUrl), { headers: auth(ADMIN_TOKEN) });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const page = await html.text();
    expect(page).toContain("Lift report");
    expect(page).toContain("Report hero");
    expect(page).not.toContain("Secret other hero");
    expect(page).toContain("Not enough data yet");

    const csv = await fetch(new URL(`/api/sites/${site}/lift-report?format=csv`, app.baseUrl), { headers: auth(ADMIN_TOKEN) });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const sheet = await csv.text();
    expect(sheet.split("\n")[0]).toContain("readout");
    expect(sheet).toContain(site);
    expect(sheet).not.toContain("Secret other hero");

    const login = await fetch(new URL("/auth/dev-login", app.baseUrl), { redirect: "manual" });
    expect(login.status).toBe(302);
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    const owner = await fetch(new URL(`/api/sites/${site}/lift-report`, app.baseUrl), { headers: { cookie } });
    expect(owner.status).toBe(200);
    const ownerBody = await owner.json();
    expect(ownerBody.site).toBe(site);
    expect(JSON.stringify(ownerBody)).not.toContain(other);
  });
});
