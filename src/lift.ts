// Lift is the difference between a personalized arm and that audience's own
// control. A readout is readable only when the 95% interval is narrow enough.
// A wide interval is "not enough data yet", including when the point estimate
// is positive.

export const RATE_WIDTH_MAX = 0.1;
export const ORDERS_PER_VISITOR_WIDTH_MAX = 0.2;
export const MIN_STABLE_MEAN = 30;

export type LiftStatus = "not_enough_data" | "higher" | "lower" | "no_clear_difference";

export type LiftReadout = {
  estimate: number | null;
  ci95: [number, number] | null;
  width: number | null;
  readable: boolean;
  status: LiftStatus;
};

export function wilson(conv: number, imp: number): [number, number] | null {
  if (imp === 0) return null;
  const z = 1.96, p = conv / imp;
  const denom = 1 + (z * z) / imp;
  const center = (p + (z * z) / (2 * imp)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * imp)) / imp)) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

// Newcombe interval on the difference of two independent proportions.
// Wilson tails keep a small sample from collapsing to a fake zero-width interval.
export function proportionDiff(
  successA: number,
  nA: number,
  successB: number,
  nB: number,
): { estimate: number | null; ci95: [number, number] | null } {
  if (nA <= 0 || nB <= 0) return { estimate: null, ci95: null };
  const pA = successA / nA;
  const pB = successB / nB;
  const estimate = pA - pB;
  const wA = wilson(successA, nA);
  const wB = wilson(successB, nB);
  if (!wA || !wB) return { estimate, ci95: null };
  const low = estimate - Math.sqrt((pA - wA[0]) ** 2 + (wB[1] - pB) ** 2);
  const high = estimate + Math.sqrt((wA[1] - pA) ** 2 + (pB - wB[0]) ** 2);
  return { estimate, ci95: [low, high] };
}

function sampleVariance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  return ss / (xs.length - 1);
}

export function meanDiff(
  a: number[],
  b: number[],
): { estimate: number | null; ci95: [number, number] | null } {
  if (a.length === 0 || b.length === 0) return { estimate: null, ci95: null };
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  const estimate = meanA - meanB;
  const va = sampleVariance(a);
  const vb = sampleVariance(b);
  if (va == null || vb == null) return { estimate, ci95: null };
  // A sample of identical values has a zero-width interval. That is an artifact
  // until the arm is large enough to treat the constant as real.
  if ((va === 0 && a.length < MIN_STABLE_MEAN) || (vb === 0 && b.length < MIN_STABLE_MEAN)) {
    return { estimate, ci95: null };
  }
  const se = Math.sqrt(va / a.length + vb / b.length);
  const half = 1.96 * se;
  return { estimate, ci95: [estimate - half, estimate + half] };
}

export function moneyWidthMax(meanA: number, meanB: number): number {
  return Math.max(Math.abs(meanA), Math.abs(meanB), 1);
}

export function judgeLift(
  estimate: number | null,
  ci95: [number, number] | null,
  widthMax: number,
): LiftReadout {
  if (estimate == null || ci95 == null) {
    return { estimate, ci95, width: null, readable: false, status: "not_enough_data" };
  }
  const width = ci95[1] - ci95[0];
  if (!Number.isFinite(width) || width > widthMax) {
    return { estimate, ci95, width, readable: false, status: "not_enough_data" };
  }
  let status: LiftStatus = "no_clear_difference";
  if (ci95[0] > 0) status = "higher";
  else if (ci95[1] < 0) status = "lower";
  return { estimate, ci95, width, readable: true, status };
}

// Visitors needed so a 95% interval on a rate difference is at most widthMax,
// using the widest Bernoulli variance (p = 0.5) and the site's holdout split.
export function sampleSizeForRateWidth(holdoutPct: number, widthMax = RATE_WIDTH_MAX): number | null {
  const h = holdoutPct / 100;
  if (!(h > 0 && h < 1) || !(widthMax > 0)) return null;
  const se = widthMax / (2 * 1.96);
  return Math.ceil(0.25 / (h * (1 - h) * se * se));
}

export function daysUntilReadable(input: {
  impressions: number;
  holdoutPct: number;
  recentImpressions: number;
  recentDays: number;
  widthMax?: number;
}): number | null {
  const needed = sampleSizeForRateWidth(input.holdoutPct, input.widthMax ?? RATE_WIDTH_MAX);
  if (needed == null) return null;
  if (input.impressions >= needed) return 0;
  if (input.recentImpressions <= 0 || input.recentDays <= 0) return null;
  const perDay = input.recentImpressions / input.recentDays;
  return Math.ceil((needed - input.impressions) / perDay);
}

export type GapReason = "no_control" | "no_traffic" | "wide" | "wait";

export function explainGap(opts: {
  holdoutPct: number;
  impressions: number;
  recentImpressions: number;
  recentDays: number;
  readable: boolean;
}): { days: number | null; reason: GapReason } {
  if (opts.readable) return { days: null, reason: "wait" };
  if (!(opts.holdoutPct > 0 && opts.holdoutPct < 100)) return { days: null, reason: "no_control" };
  const days = daysUntilReadable(opts);
  if (opts.recentImpressions <= 0) return { days: null, reason: "no_traffic" };
  if (days == null || days <= 0) return { days: days ?? 0, reason: "wide" };
  return { days, reason: "wait" };
}

export function notEnoughCopy(days: number | null, reason: GapReason): string {
  if (reason === "no_control") return "Not enough data yet. This site's holdout leaves no control group to compare.";
  if (reason === "wide") return "Not enough data yet. The interval is still too wide to read.";
  if (reason === "no_traffic" || days == null) return "Not enough data yet. There is no recent traffic to estimate a wait.";
  const unit = days === 1 ? "day" : "days";
  return `Not enough data yet. At the current pace, about ${days} ${unit} until this comparison is readable.`;
}

export function metricText(
  label: string,
  readout: LiftReadout,
  format: (n: number) => string,
  days: number | null,
  reason: GapReason,
): string {
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  if (!readout.readable || !readout.ci95 || readout.estimate == null) {
    return `${name}: ${notEnoughCopy(days, reason)}`;
  }
  const low = format(readout.ci95[0]);
  const high = format(readout.ci95[1]);
  if (readout.status === "higher") {
    return `${name}: personalized is higher than this audience's control. The 95% interval on the difference is ${low} to ${high}.`;
  }
  if (readout.status === "lower") {
    return `${name}: personalized is lower than this audience's control. The 95% interval on the difference is ${low} to ${high}.`;
  }
  return `${name}: the 95% interval on the difference is ${low} to ${high}, and it crosses zero.`;
}

export function formatRatePoints(n: number): string {
  const points = n * 100;
  const digits = Math.abs(points) >= 10 ? 1 : 2;
  return `${points.toFixed(digits)} percentage points`;
}

export const REPORT_NOTE =
  "Each audience is compared with the visitors held out of that same audience. Older events with no audience stay in the pooled totals.";
