// Per-audience lift. Events with no audience_key stay out of these comparisons
// and remain in the pooled stats.
import { experienceArms } from "./counts";
import { db } from "./db";
import { audienceKey, audienceLabel, controlArm } from "./holdout";
import {
  ORDERS_PER_VISITOR_WIDTH_MAX,
  RATE_WIDTH_MAX,
  explainGap,
  formatRatePoints,
  judgeLift,
  meanDiff,
  metricText,
  moneyWidthMax,
  proportionDiff,
  wilson,
  type GapReason,
  type LiftReadout,
} from "./lift";
import { formatMinor, reportArm, type ArmOrders } from "./money";

export type MetricRow = {
  key: string;
  label: string;
  treated: string;
  control: string;
  estimate: number | null;
  ci95: [number, number] | null;
  readable: boolean;
  status: LiftReadout["status"];
  text: string;
};

export type ArmSnapshot = ArmOrders & {
  impressions: number;
  conversions: number;
  rate: number | null;
  ci95: [number, number] | null;
};

export type ExperienceSnapshot = {
  selector: string;
  audienceKey: string;
  audienceLabel: string;
  variantIds: number[];
  names: string[];
  treated: ArmSnapshot;
  control: ArmSnapshot;
  daysUntilReadable: number | null;
  metrics: MetricRow[];
};

type VariantRow = { id: number; name: string; selector: string; audience: string };
type VisitorRow = { variant_id: number | null; selector: string; audience_key: string; visitor_id: string };
type OrderRow = { arm: string; order_id: string; visitor_id: string; currency: string; value_minor: number };
type RecentRow = { selector: string; audience_key: string; n: number; first_ts: number };

const RECENT_MS = 7 * 86400000;

function groupId(selector: string, key: string): string {
  return selector + "\0" + key;
}

function armSnapshot(
  impressions: number,
  conversions: number,
  visitors: string[],
  orders: { visitorId: string; currency: string; valueMinor: number }[],
): ArmSnapshot {
  return {
    impressions,
    conversions,
    rate: impressions ? conversions / impressions : null,
    ci95: wilson(conversions, impressions),
    ...reportArm(visitors, orders),
  };
}

function countsFor(visitors: string[], orders: OrderRow[]): number[] {
  const counts = new Map(visitors.map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const o of orders) {
    if (!counts.has(o.visitor_id) || seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    counts.set(o.visitor_id, counts.get(o.visitor_id)! + 1);
  }
  return [...counts.values()];
}

function revenueSamples(visitors: string[], orders: OrderRow[], currency: string): number[] {
  const sums = new Map(visitors.map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const o of orders) {
    if (o.currency !== currency || !sums.has(o.visitor_id) || seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    sums.set(o.visitor_id, sums.get(o.visitor_id)! + o.value_minor);
  }
  return [...sums.values()];
}

function aovSamples(orders: OrderRow[], currency: string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const o of orders) {
    if (o.currency !== currency || seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    out.push(o.value_minor);
  }
  return out;
}

function rateLabel(arm: ArmSnapshot): string {
  if (arm.rate == null) return "no impressions";
  return `${(100 * arm.rate).toFixed(1)}% (${arm.impressions.toLocaleString()} impressions)`;
}

function opvLabel(arm: ArmSnapshot): string {
  if (arm.ordersPerVisitor == null) return "no visitors";
  return arm.ordersPerVisitor.toFixed(3);
}

function moneyLabel(arm: ArmSnapshot, field: "rpv" | "aov", currency: string): string {
  const row = arm.revenue.find((r) => r.currency === currency);
  const value = row?.[field];
  if (value == null) return "none";
  return `${currency} ${value}`;
}

function rowFrom(
  key: string,
  label: string,
  readout: LiftReadout,
  treated: string,
  control: string,
  format: (n: number) => string,
  days: number | null,
  reason: GapReason,
): MetricRow {
  return {
    key,
    label,
    treated,
    control,
    estimate: readout.estimate,
    ci95: readout.ci95,
    readable: readout.readable,
    status: readout.status,
    text: metricText(label, readout, format, days, reason),
  };
}

export function buildExperiences(site: string, holdoutPct: number, now = Date.now()): ExperienceSnapshot[] {
  const variants = db.prepare(
    "SELECT id, name, selector, audience FROM variants WHERE site = ? ORDER BY id",
  ).all(site) as VariantRow[];

  const groups = new Map<string, { selector: string; key: string; ids: number[]; names: string[] }>();
  for (const v of variants) {
    const key = audienceKey(v.audience);
    const id = groupId(v.selector, key);
    const g = groups.get(id) ?? { selector: v.selector, key, ids: [], names: [] };
    g.ids.push(v.id);
    g.names.push(v.name);
    groups.set(id, g);
  }

  const counts = experienceArms(db, site);

  const visitors = db.prepare(
    `SELECT DISTINCT variant_id, selector, audience_key, visitor_id
     FROM events
     WHERE site = ? AND type = 'impression' AND audience_key IS NOT NULL`,
  ).all(site) as VisitorRow[];

  const orders = db.prepare(
    `SELECT c.arm, o.order_id, o.visitor_id, o.currency, o.value_minor
     FROM orders o
     JOIN order_credits c ON c.site = o.site AND c.order_id = o.order_id
     WHERE o.site = ?`,
  ).all(site) as OrderRow[];

  const recent = db.prepare(
    `SELECT selector, audience_key, COUNT(*) AS n, MIN(ts) AS first_ts
     FROM events
     WHERE site = ? AND type = 'impression' AND audience_key IS NOT NULL AND ts >= ?
     GROUP BY selector, audience_key`,
  ).all(site, now - RECENT_MS) as RecentRow[];
  const recentBy = new Map(recent.map((r) => [groupId(r.selector, r.audience_key), r]));

  const out: ExperienceSnapshot[] = [];
  for (const g of groups.values()) {
    const idSet = new Set(g.ids);
    const treatedCounts = counts.filter((r) => r.selector === g.selector && r.audience_key === g.key && r.variant_id != null && idSet.has(r.variant_id));
    const controlCounts = counts.filter((r) => r.selector === g.selector && r.audience_key === g.key && r.variant_id == null);
    const treatedVisitors = [...new Set(
      visitors.filter((r) => r.selector === g.selector && r.audience_key === g.key && r.variant_id != null && idSet.has(r.variant_id)).map((r) => r.visitor_id),
    )];
    const controlVisitors = [...new Set(
      visitors.filter((r) => r.selector === g.selector && r.audience_key === g.key && r.variant_id == null).map((r) => r.visitor_id),
    )];
    const treatedVisitorSet = new Set(treatedVisitors);
    const controlVisitorSet = new Set(controlVisitors);
    const arm = controlArm(g.key);
    const dedupeOrders = (rows: OrderRow[]) => {
      const seen = new Set<string>();
      return rows.filter((o) => (seen.has(o.order_id) ? false : (seen.add(o.order_id), true)));
    };
    const treatedOrders = dedupeOrders(orders.filter((o) => idSet.has(Number(o.arm)) && treatedVisitorSet.has(o.visitor_id)));
    const controlOrders = dedupeOrders(orders.filter((o) => o.arm === arm && controlVisitorSet.has(o.visitor_id)));
    const treated = armSnapshot(
      treatedCounts.reduce((s, r) => s + Number(r.impressions), 0),
      treatedCounts.reduce((s, r) => s + Number(r.conversions), 0),
      treatedVisitors,
      treatedOrders.map((o) => ({ visitorId: o.visitor_id, currency: o.currency, valueMinor: o.value_minor })),
    );
    const control = armSnapshot(
      controlCounts.reduce((s, r) => s + Number(r.impressions), 0),
      controlCounts.reduce((s, r) => s + Number(r.conversions), 0),
      controlVisitors,
      controlOrders.map((o) => ({ visitorId: o.visitor_id, currency: o.currency, valueMinor: o.value_minor })),
    );

    const pace = recentBy.get(groupId(g.selector, g.key));
    const recentImpressions = pace?.n ?? 0;
    const recentDays = pace ? Math.max(1, (now - pace.first_ts) / 86400000) : 7;
    const impressions = treated.impressions + control.impressions;

    const clickDiff = proportionDiff(treated.conversions, treated.impressions, control.conversions, control.impressions);
    const clicks = judgeLift(clickDiff.estimate, clickDiff.ci95, RATE_WIDTH_MAX);
    const clickGap = explainGap({
      holdoutPct,
      impressions,
      recentImpressions,
      recentDays,
      readable: clicks.readable,
    });

    const opvA = countsFor(treatedVisitors, treatedOrders);
    const opvB = countsFor(controlVisitors, controlOrders);
    const opvDiff = meanDiff(opvA, opvB);
    const opv = judgeLift(opvDiff.estimate, opvDiff.ci95, ORDERS_PER_VISITOR_WIDTH_MAX);
    const opvGap = explainGap({ holdoutPct, impressions, recentImpressions, recentDays, readable: opv.readable });

    const currencies = [...new Set([...treated.revenue, ...control.revenue].map((r) => r.currency))].sort();
    const metrics: MetricRow[] = [
      rowFrom("click_rate", "click rate", clicks, rateLabel(treated), rateLabel(control), formatRatePoints, clickGap.days, clickGap.reason),
      rowFrom(
        "orders_per_visitor",
        "orders per visitor",
        opv,
        opvLabel(treated),
        opvLabel(control),
        (n) => n.toFixed(3),
        opvGap.days,
        opvGap.reason,
      ),
    ];

    const moneyMetrics = currencies.length ? currencies : [""];
    for (const currency of moneyMetrics) {
      const suffix = currency ? ` (${currency})` : "";
      const keySuffix = currency ? `:${currency}` : "";
      const money = (n: number) => currency ? `${currency} ${formatMinor(Math.round(n), currency)}` : n.toFixed(0);
      if (!currency) {
        const empty = judgeLift(null, null, 1);
        const gap = explainGap({ holdoutPct, impressions, recentImpressions, recentDays, readable: false });
        metrics.push(rowFrom("rpv", "revenue per visitor", empty, "none", "none", money, gap.days, gap.reason));
        metrics.push(rowFrom("aov", "average order value", empty, "none", "none", money, gap.days, gap.reason));
        continue;
      }
      const rpvA = revenueSamples(treatedVisitors, treatedOrders, currency);
      const rpvB = revenueSamples(controlVisitors, controlOrders, currency);
      const rpvDiff = meanDiff(rpvA, rpvB);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);
      const rpv = judgeLift(rpvDiff.estimate, rpvDiff.ci95, moneyWidthMax(avg(rpvA), avg(rpvB)));
      const rpvGap = explainGap({ holdoutPct, impressions, recentImpressions, recentDays, readable: rpv.readable });
      metrics.push(rowFrom(`rpv${keySuffix}`, `revenue per visitor${suffix}`, rpv, moneyLabel(treated, "rpv", currency), moneyLabel(control, "rpv", currency), money, rpvGap.days, rpvGap.reason));

      const samplesA = aovSamples(treatedOrders, currency);
      const samplesB = aovSamples(controlOrders, currency);
      const aovDiff = meanDiff(samplesA, samplesB);
      const aov = judgeLift(aovDiff.estimate, aovDiff.ci95, moneyWidthMax(avg(samplesA), avg(samplesB)));
      const aovGap = explainGap({ holdoutPct, impressions, recentImpressions, recentDays, readable: aov.readable });
      metrics.push(rowFrom(`aov${keySuffix}`, `average order value${suffix}`, aov, moneyLabel(treated, "aov", currency), moneyLabel(control, "aov", currency), money, aovGap.days, aovGap.reason));
    }

    out.push({
      selector: g.selector,
      audienceKey: g.key,
      audienceLabel: audienceLabel(g.key),
      variantIds: g.ids,
      names: g.names,
      treated,
      control,
      daysUntilReadable: clickGap.days,
      metrics,
    });
  }

  out.sort((a, b) => a.selector.localeCompare(b.selector) || a.audienceLabel.localeCompare(b.audienceLabel));
  return out;
}

export type LiftReport = {
  site: string;
  generatedAt: string;
  holdoutPct: number;
  holdoutPctSource: "site" | "default";
  note: string;
  experiences: ExperienceSnapshot[];
  pooled: {
    variants: { id: number; name: string; selector: string; impressions: number; conversions: number; orders: number }[];
    control: { impressions: number; conversions: number; orders: number };
  };
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function renderLiftHtml(report: LiftReport): string {
  const blocks = report.experiences.map((exp) => {
    const rows = exp.metrics.map((m) =>
      `<tr><td>${esc(m.label)}</td><td>${esc(m.treated)}</td><td>${esc(m.control)}</td><td>${esc(m.text)}</td></tr>`,
    ).join("");
    return `<section>
      <h2>${esc(exp.selector)}</h2>
      <p>${esc(exp.audienceLabel)}. Variants: ${esc(exp.names.join(", ") || "none")}.</p>
      <table>
        <thead><tr><th>Metric</th><th>Personalized</th><th>Control</th><th>Readout</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join("");
  const pooledRows = report.pooled.variants.map((v) =>
    `<tr><td>${esc(v.name)}</td><td>${esc(v.selector)}</td><td>${v.impressions}</td><td>${v.conversions}</td><td>${v.orders}</td></tr>`,
  ).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Lift report: ${esc(report.site)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #14161c; max-width: 880px; margin: 32px auto; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 28px 0 4px; }
  p, td, th { font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 4px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e4e4e0; vertical-align: top; }
  th { color: #666; font-weight: 600; }
  .meta { color: #555; }
  @media print { body { margin: 0; } section { break-inside: avoid; } }
</style></head>
<body>
  <h1>Lift report</h1>
  <p class="meta">${esc(report.site)}. ${esc(report.generatedAt)}. Holdout ${report.holdoutPct}% (${report.holdoutPctSource === "site" ? "set for this site" : "deployment default"}).</p>
  <p>${esc(report.note)}</p>
  ${blocks || "<p>No audiences yet.</p>"}
  <h2>Pooled totals</h2>
  <p class="meta">Every recorded impression for this site, including events with no audience.</p>
  <table>
    <thead><tr><th>Name</th><th>Selector</th><th>Impressions</th><th>Conversions</th><th>Orders</th></tr></thead>
    <tbody>
      ${pooledRows}
      <tr><td>Control</td><td></td><td>${report.pooled.control.impressions}</td><td>${report.pooled.control.conversions}</td><td>${report.pooled.control.orders}</td></tr>
    </tbody>
  </table>
</body></html>`;
}

function csvField(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function renderLiftCsv(report: LiftReport): string {
  const header = ["site", "selector", "audience", "metric", "personalized", "control", "estimate", "ci_low", "ci_high", "status", "days_until_readable", "readout"];
  const lines = [header.join(",")];
  for (const exp of report.experiences) {
    for (const m of exp.metrics) {
      lines.push([
        report.site,
        exp.selector,
        exp.audienceLabel,
        m.key,
        m.treated,
        m.control,
        m.estimate ?? "",
        m.ci95 ? m.ci95[0] : "",
        m.ci95 ? m.ci95[1] : "",
        m.status,
        exp.daysUntilReadable ?? "",
        m.text,
      ].map(csvField).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
