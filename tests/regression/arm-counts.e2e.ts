import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { ADMIN_TOKEN } from "../support/env.ts";
import { api } from "../support/helpers.ts";

const uid = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

describe("regression: variant counts", { tags: ["regression"] }, () => {
  test("stats match posted impressions and conversions, including after erasure", async ({ app }) => {
    const site = uid("counts");
    const created = await api(app.baseUrl, "/api/variants", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      json: { site, name: "Hero", selector: "#hero", ops: "[]", audience: "[]" },
    });
    expect(created.status).toBe(201);
    const variantId = created.body.id as number;

    const posted = await api(app.baseUrl, "/api/events", {
      method: "POST",
      json: {
        site,
        visitorId: "alice",
        events: [
          { type: "impression", variantId, selector: "#hero", audienceKey: "[]" },
          { type: "impression", variantId, selector: "#hero", audienceKey: "[]" },
          { type: "conversion", variantId, selector: "#hero", audienceKey: "[]" },
          { type: "impression", variantId, selector: "#hero" },
          { type: "impression", variantId: null, selector: "#hero", audienceKey: "[]" },
          { type: "conversion", variantId, selector: "#missing" },
        ],
      },
    });
    expect(posted.status).toBe(200);
    expect(posted.body.recorded).toBe(5);

    const stats = await api(app.baseUrl, `/api/stats?site=${site}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(stats.status).toBe(200);
    const hero = stats.body.variants.find((row: { id: number }) => row.id === variantId);
    expect(hero.impressions).toBe(3);
    expect(hero.conversions).toBe(1);
    expect(stats.body.control.impressions).toBe(1);
    expect(stats.body.control.conversions).toBe(0);
    const everyone = stats.body.experiences.find((row: { audienceKey: string }) => row.audienceKey === "[]");
    expect(everyone.treated.impressions).toBe(2);
    expect(everyone.treated.conversions).toBe(1);
    expect(everyone.control.impressions).toBe(1);

    const erased = await api(app.baseUrl, `/api/visitors/alice?site=${site}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(erased.status).toBe(200);

    const after = await api(app.baseUrl, `/api/stats?site=${site}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const heroAfter = after.body.variants.find((row: { id: number }) => row.id === variantId);
    expect(heroAfter.impressions).toBe(0);
    expect(heroAfter.conversions).toBe(0);
    expect(after.body.control.impressions).toBe(0);
    const everyoneAfter = after.body.experiences.find((row: { audienceKey: string }) => row.audienceKey === "[]");
    expect(everyoneAfter.treated.impressions).toBe(0);
    expect(everyoneAfter.control.impressions).toBe(0);
  });
});
