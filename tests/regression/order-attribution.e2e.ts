import { join } from "node:path";
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { ADMIN_TOKEN } from "../support/env.ts";
import { api } from "../support/helpers.ts";
import { loadOrderEventFromCheckout, recordedCheckout } from "../support/pixel.ts";

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

describe("regression: order attribution", { tags: ["regression"] }, () => {
  test("decide, impression, then a recorded Shopify order shows on the arm and the dashboard", async ({ app, screen }) => {
    const site = uid("ord");
    const created = await api(app.baseUrl, "/api/variants", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      json: { site, name: "Order hero", selector: "#hero", ops: "[]", audience: "[]" },
    });
    expect(created.status).toBe(201);

    const vid = uid("v");
    const decided = await api(app.baseUrl, "/api/decide", { method: "POST", json: { visitorId: vid, site } });
    expect(decided.status).toBe(200);
    expect(decided.body.decisions).toEqual([expect.objectContaining({ selector: "#hero", variantId: created.body.id })]);
    const decision = decided.body.decisions[0];

    const impression = await api(app.baseUrl, "/api/events", {
      method: "POST",
      json: { site, visitorId: vid, events: [{ type: "impression", variantId: decision.variantId, selector: decision.selector }] },
    });
    expect(impression.body.recorded).toBe(1);

    const checkout = recordedCheckout(join(import.meta.dir, "../.."));
    const mapped = loadOrderEventFromCheckout(join(import.meta.dir, "../.."))(checkout.data.checkout, vid);
    expect(mapped?.events[0]?.orderId).toBe("gid://shopify/Order/820982911946154508");
    const posted = await api(app.baseUrl, "/api/events", { method: "POST", json: { ...mapped, site } });
    expect(posted.status).toBe(200);
    expect(posted.body.recorded).toBe(1);
    const replay = await api(app.baseUrl, "/api/events", { method: "POST", json: { ...mapped, site } });
    expect(replay.body.recorded).toBe(0);

    const controlId = uid("ctl");
    await api(app.baseUrl, "/api/events", {
      method: "POST",
      json: { site, visitorId: controlId, events: [{ type: "impression", variantId: null, selector: "#hero" }] },
    });
    const controlOrder = await api(app.baseUrl, "/api/events", {
      method: "POST",
      json: {
        site,
        visitorId: controlId,
        events: [{ type: "order", orderId: "ord_control", value: "12.50", currency: "USD" }],
      },
    });
    expect(controlOrder.body.recorded).toBe(1);

    const unseen = await api(app.baseUrl, "/api/events", {
      method: "POST",
      json: { site, visitorId: uid("none"), events: [{ type: "order", orderId: "ord_none", value: "9.00", currency: "USD" }] },
    });
    expect(unseen.body.recorded).toBe(0);

    const s = await api(app.baseUrl, `/api/stats?site=${site}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(s.status).toBe(200);
    const hero = s.body.variants.find((v: { name: string }) => v.name === "Order hero");
    expect(hero.impressions).toBe(1);
    expect(hero.conversions).toBe(0);
    expect(hero.orders).toBe(1);
    expect(hero.revenue).toEqual([expect.objectContaining({ currency: "USD", revenue: "48.00", revenueMinor: 4800 })]);
    expect(s.body.control.orders).toBe(1);
    expect(s.body.control.revenue[0].revenue).toBe("12.50");
    expect(s.body.control.impressions).toBe(1);

    await app.open(`/admin?token=${ADMIN_TOKEN}&site=${site}`);
    await expect(screen.getByRole("columnheader", "Revenue")).toBeVisible();
    await expect(screen.getByText("USD 48.00", { exact: false })).toBeVisible();
    await expect(screen.getByText("USD 12.50", { exact: false })).toBeVisible();
  });
});
