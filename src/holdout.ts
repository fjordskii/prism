// Sticky holdout assignment. The bucket is a deterministic hash of the visitor,
// the selector, and the audience, so each audience keeps its own control arm.

export function audienceKey(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "[]";
  }
  if (!Array.isArray(parsed)) return "[]";
  const rules = parsed.map((rule) => {
    if (!rule || typeof rule !== "object") return { field: "", op: "", value: null };
    const r = rule as { field?: unknown; op?: unknown; value?: unknown };
    return { field: String(r.field ?? ""), op: String(r.op ?? ""), value: r.value ?? null };
  });
  return JSON.stringify(rules);
}

const OP_LABEL: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contains",
};

export function audienceLabel(key: string): string {
  let rules: { field?: string; op?: string; value?: unknown }[];
  try {
    rules = JSON.parse(key);
  } catch {
    return "everyone";
  }
  if (!Array.isArray(rules) || rules.length === 0) return "everyone";
  return rules
    .map((r) => `${r.field ?? ""} ${OP_LABEL[r.op ?? ""] ?? r.op ?? ""} ${JSON.stringify(r.value ?? null)}`)
    .join(" and ");
}

// Same polynomial as the original per-selector hash, with the audience mixed in.
export function holdoutBucket(visitorId: string, selector: string, key: string): number {
  let h = 0;
  const s = visitorId + ":" + selector + ":" + key;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 100;
}

export function isHoldout(visitorId: string, selector: string, key: string, pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return holdoutBucket(visitorId, selector, key) < pct;
}

// One selector can match more than one audience. The visitor enters exactly one
// of them, chosen by a second hash, then the holdout bucket is applied inside it.
export function pickExperience(visitorId: string, selector: string, keys: string[]): string {
  const sorted = [...keys].sort();
  if (sorted.length === 0) return "[]";
  if (sorted.length === 1) return sorted[0]!;
  let h = 0;
  const s = visitorId + ":" + selector + ":experience";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return sorted[h % sorted.length]!;
}

export function defaultHoldoutPct(): number {
  const n = Number(process.env.HOLDOUT_PCT ?? 10);
  if (!Number.isFinite(n)) return 10;
  return Math.min(100, Math.max(0, Math.trunc(n)));
}

export function controlArm(key: string): string {
  return "control:" + key;
}
