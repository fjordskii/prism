// Order amounts are integer minor units. Stats intervals for orders are normal
// approximations of a sample mean, z = 1.96, standard deviation over n - 1.
// The interval is null when n < 2. A lower bound below 0 is raised to 0.
// Orders per visitor is the mean of per-visitor order counts. The orders
// interval is that mean interval times the visitor count. RPV is the mean of
// per-visitor revenue in one currency, and a visitor with no order in that
// currency contributes 0. The revenue interval is that mean interval times the
// visitor count. AOV is the mean of the order amounts in that currency.
// Currencies are separate samples and are never added together.
// Click rate stays the Wilson interval on ci95.

const ZERO_EXP = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_EXP = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function exponent(currency: string): number {
  if (ZERO_EXP.has(currency)) return 0;
  if (THREE_EXP.has(currency)) return 3;
  return 2;
}

export type ParsedOrder = { orderId: string; currency: string; valueMinor: number };
export type OrderFailure = { ok: false; field: "orderId" | "value" | "currency"; message: string };

export function parseOrder(raw: { orderId?: unknown; value?: unknown; currency?: unknown }): { ok: true; order: ParsedOrder } | OrderFailure {
  if (raw.orderId == null || raw.orderId === "") return { ok: false, field: "orderId", message: "missing orderId" };
  if (typeof raw.orderId !== "string" || raw.orderId.length > 128 || /[\u0000-\u001f]/.test(raw.orderId)) {
    return { ok: false, field: "orderId", message: "invalid orderId" };
  }
  if (typeof raw.currency !== "string" || !/^[A-Za-z]{3}$/.test(raw.currency)) {
    return { ok: false, field: "currency", message: "invalid currency" };
  }
  const currency = raw.currency.toUpperCase();
  const valueMinor = toMinor(raw.value, exponent(currency));
  if (valueMinor == null) return { ok: false, field: "value", message: "invalid value" };
  return { ok: true, order: { orderId: raw.orderId, currency, valueMinor } };
}

function toMinor(value: unknown, exp: number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const scaled = value * 10 ** exp;
    const minor = Math.round(scaled);
    if (Math.abs(scaled - minor) > 1e-6 || !Number.isSafeInteger(minor)) return null;
    return minor;
  }
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > exp) return null;
  const digits = whole + frac.padEnd(exp, "0");
  if (digits.length > 15) return null;
  const minor = Number(digits);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatMinor(minor: number, currency: string): string {
  const exp = exponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(minor))).padStart(exp + 1, "0");
  if (exp === 0) return sign + digits;
  return sign + digits.slice(0, -exp) + "." + digits.slice(-exp);
}

function formatMajor(minor: number, currency: string): string {
  return (minor / 10 ** exponent(currency)).toFixed(exponent(currency));
}

function meanCi(samples: number[]): { mean: number; low: number; high: number } | null {
  const n = samples.length;
  if (n < 2) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const ss = samples.reduce((a, x) => a + (x - mean) ** 2, 0);
  const half = 1.96 * Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
  return { mean, low: mean - half, high: mean + half };
}

export type CurrencyStats = {
  currency: string;
  orders: number;
  revenueMinor: number;
  revenue: string;
  revenueCi95: [string, string] | null;
  rpv: string | null;
  rpvCi95: [string, string] | null;
  aov: string | null;
  aovCi95: [string, string] | null;
};

export type ArmOrders = {
  orders: number;
  ordersCi95: [number, number] | null;
  ordersPerVisitor: number | null;
  ordersPerVisitorCi95: [number, number] | null;
  revenue: CurrencyStats[];
};

export function reportArm(visitorIds: string[], orders: { visitorId: string; currency: string; valueMinor: number }[]): ArmOrders {
  const visitors = [...new Set(visitorIds)];
  const n = visitors.length;
  const counts = new Map(visitors.map((id) => [id, 0]));
  const kept = orders.filter((o) => counts.has(o.visitorId));
  for (const o of kept) counts.set(o.visitorId, counts.get(o.visitorId)! + 1);
  const countCi = meanCi([...counts.values()]);
  const byCurrency = new Map<string, typeof kept>();
  for (const o of kept) {
    const list = byCurrency.get(o.currency) ?? [];
    list.push(o);
    byCurrency.set(o.currency, list);
  }
  const revenue = [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, list]) => {
    const perVisitor = new Map(visitors.map((id) => [id, 0]));
    for (const o of list) perVisitor.set(o.visitorId, (perVisitor.get(o.visitorId) ?? 0) + o.valueMinor);
    const ci = meanCi([...perVisitor.values()]);
    const sum = list.reduce((a, o) => a + o.valueMinor, 0);
    const aovCi = meanCi(list.map((o) => o.valueMinor));
    return {
      currency,
      orders: list.length,
      revenueMinor: sum,
      revenue: formatMinor(sum, currency),
      revenueCi95: ci && n ? [formatMajor(Math.max(0, ci.low * n), currency), formatMajor(ci.high * n, currency)] : null,
      rpv: n ? formatMajor(sum / n, currency) : null,
      rpvCi95: ci ? [formatMajor(Math.max(0, ci.low), currency), formatMajor(ci.high, currency)] : null,
      aov: formatMajor(sum / list.length, currency),
      aovCi95: aovCi ? [formatMajor(Math.max(0, aovCi.low), currency), formatMajor(aovCi.high, currency)] : null,
    };
  });
  return {
    orders: kept.length,
    ordersCi95: countCi ? [Math.max(0, countCi.low * n), countCi.high * n] : null,
    ordersPerVisitor: n ? kept.length / n : null,
    ordersPerVisitorCi95: countCi ? [Math.max(0, countCi.low), countCi.high] : null,
    revenue,
  };
}
