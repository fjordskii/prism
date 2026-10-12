import { describe, expect, test } from "bun:test";
import { audienceKey, holdoutBucket, isHoldout, pickExperience } from "../../src/holdout";
import {
  RATE_WIDTH_MAX,
  daysUntilReadable,
  formatRatePoints,
  judgeLift,
  meanDiff,
  metricText,
  notEnoughCopy,
  proportionDiff,
  sampleSizeForRateWidth,
} from "../../src/lift";

const gift = JSON.stringify([{ field: "intent", op: "eq", value: "gift" }]);
const bundle = JSON.stringify([{ field: "cartItems", op: "gte", value: 3 }]);

describe("holdout assignment", () => {
  test("the same visitor, selector, and audience stay in the same arm", () => {
    const key = audienceKey(gift);
    const first = isHoldout("visitor-7", "#hero", key, 30);
    for (let i = 0; i < 25; i++) expect(isHoldout("visitor-7", "#hero", key, 30)).toBe(first);
    expect(holdoutBucket("visitor-7", "#hero", key)).toBe(holdoutBucket("visitor-7", "#hero", key));
  });

  test("0% holds out nobody and 100% holds out everybody", () => {
    const key = audienceKey(gift);
    for (let i = 0; i < 40; i++) {
      expect(isHoldout("v" + i, "#hero", key, 0)).toBe(false);
      expect(isHoldout("v" + i, "#hero", key, 100)).toBe(true);
    }
  });

  test("two audiences on one selector get separate splits", () => {
    const a = audienceKey(gift);
    const b = audienceKey(bundle);
    expect(a).not.toBe(b);
    let aHold = 0;
    let bHold = 0;
    let differ = 0;
    const n = 800;
    for (let i = 0; i < n; i++) {
      const id = "split-" + i;
      const ha = isHoldout(id, "#hero", a, 30);
      const hb = isHoldout(id, "#hero", b, 30);
      if (ha) aHold++;
      if (hb) bHold++;
      if (ha !== hb) differ++;
    }
    expect(aHold / n).toBeGreaterThan(0.22);
    expect(aHold / n).toBeLessThan(0.38);
    expect(bHold / n).toBeGreaterThan(0.22);
    expect(bHold / n).toBeLessThan(0.38);
    expect(differ).toBeGreaterThan(80);
  });

  test("whitespace in the audience JSON does not change the bucket", () => {
    const compact = audienceKey(gift);
    const spaced = audienceKey('[\n  { "field": "intent", "op": "eq", "value": "gift" }\n]');
    expect(spaced).toBe(compact);
    expect(isHoldout("visitor-7", "#hero", spaced, 30)).toBe(isHoldout("visitor-7", "#hero", compact, 30));
  });

  test("a visitor who matches two audiences enters one of them, stickily", () => {
    const keys = [audienceKey(gift), audienceKey(bundle)];
    const chosen = pickExperience("overlap-visitor", "#hero", keys);
    expect(keys).toContain(chosen);
    for (let i = 0; i < 10; i++) expect(pickExperience("overlap-visitor", "#hero", keys)).toBe(chosen);
    expect(pickExperience("overlap-visitor", "#hero", [keys[0]!])).toBe(keys[0]);
  });
});

describe("lift readout", () => {
  test("a small sample with a positive point estimate is not enough data", () => {
    const diff = proportionDiff(5, 5, 0, 5);
    const readout = judgeLift(diff.estimate, diff.ci95, RATE_WIDTH_MAX);
    expect(diff.estimate).toBe(1);
    expect(readout.readable).toBe(false);
    expect(readout.status).toBe("not_enough_data");
    const text = metricText("click rate", readout, formatRatePoints, 40, "wait");
    expect(text).toContain("Not enough data yet");
    expect(text.toLowerCase()).not.toContain("win");
    expect(text).not.toContain("\u2014");
    expect(text.toLowerCase()).not.toContain("increase sales");
  });

  test("a narrow interval entirely above zero is readable and still not called a win", () => {
    const diff = proportionDiff(1500, 5000, 1000, 5000);
    const readout = judgeLift(diff.estimate, diff.ci95, RATE_WIDTH_MAX);
    expect(readout.readable).toBe(true);
    expect(readout.status).toBe("higher");
    expect(readout.ci95![0]).toBeGreaterThan(0);
    const text = metricText("click rate", readout, formatRatePoints, null, "wait");
    expect(text).toContain("95% interval");
    expect(text.toLowerCase()).not.toContain("win");
    expect(text).not.toContain("\u2014");
  });

  test("an interval that crosses zero is not a higher readout", () => {
    const readout = judgeLift(0.01, [-0.02, 0.04], RATE_WIDTH_MAX);
    expect(readout.readable).toBe(true);
    expect(readout.status).toBe("no_clear_difference");
  });

  test("orders per visitor uses the mean interval and the width threshold", () => {
    const thin = meanDiff([1, 0], [0, 0]);
    expect(judgeLift(thin.estimate, thin.ci95, 0.2).status).toBe("not_enough_data");
    const treated = Array.from({ length: 80 }, (_, i) => (i % 5 === 0 ? 1 : 0));
    const control = Array.from({ length: 80 }, () => 0);
    const wideEnough = meanDiff(treated, control);
    const judged = judgeLift(wideEnough.estimate, wideEnough.ci95, 0.2);
    expect(judged.ci95).not.toBeNull();
    expect(judged.status === "higher" || judged.status === "not_enough_data").toBe(true);
  });

  test("days until readable follows the sample size at the current pace", () => {
    const needed = sampleSizeForRateWidth(10, RATE_WIDTH_MAX);
    expect(needed).toBeGreaterThan(1000);
    const days = daysUntilReadable({
      impressions: 100,
      holdoutPct: 10,
      recentImpressions: 70,
      recentDays: 7,
      widthMax: RATE_WIDTH_MAX,
    });
    expect(days).toBe(Math.ceil((needed! - 100) / 10));
    const copy = notEnoughCopy(days, "wait");
    expect(copy.startsWith("Not enough data yet")).toBe(true);
    expect(copy).toContain(String(days));
    expect(copy).not.toContain("\u2014");
    expect(notEnoughCopy(null, "no_traffic")).toContain("no recent traffic");
    expect(notEnoughCopy(null, "no_control")).toContain("no control group");
  });
});
