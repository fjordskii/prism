// Plan registry: makes the pricing-page limits enforceable in code.
import { db } from "./db";

export type PlanDef = { visitors: number | null; sites: number | null; personalize: boolean };
export const PLANS: Record<string, PlanDef> = {
  shadow:   { visitors: 10_000,    sites: 1,    personalize: false },
  growth:   { visitors: 100_000,   sites: 3,    personalize: true  },
  pro:      { visitors: 500_000,   sites: 5,    personalize: true  },
  agency:   { visitors: 1_000_000, sites: null, personalize: true  },
  selfhost: { visitors: null,      sites: null, personalize: true  }, // null = unlimited
};

// Plan assigned to newly-registered sites on this deployment.
const DEPLOY_PLAN = process.env.PRISM_PLAN ?? "selfhost";

// First day of the current UTC month, ms epoch.
export function monthStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const getSite = db.prepare("SELECT plan, holdout_pct FROM sites WHERE site = ?");
const insSite = db.prepare("INSERT OR IGNORE INTO sites (site, plan, created_at) VALUES (?, ?, ?)");

// Unknown sites report the deployment plan without being registered.
// applyCap and the plan endpoint are the only inserts.
export function sitePlan(site: string): { plan: string; def: PlanDef } {
  const row = getSite.get(site) as { plan: string } | null;
  const plan = row?.plan ?? DEPLOY_PLAN;
  return { plan, def: PLANS[plan] ?? PLANS.selfhost! };
}

const cntVisitors = db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site = ? AND last_seen >= ?");

export function usageFor(site: string): { visitors: number; visitorCap: number | null; overLimit: boolean } {
  const { def } = sitePlan(site);
  const row = cntVisitors.get(site, monthStart()) as { n: number };
  return { visitors: row.n, visitorCap: def.visitors, overLimit: def.visitors !== null && row.n > def.visitors };
}

export function holdoutFor(site: string, fallback: number): { pct: number; source: "site" | "default" } {
  const row = getSite.get(site) as { holdout_pct: number | null } | null;
  if (row && row.holdout_pct != null && Number.isFinite(row.holdout_pct)) {
    return { pct: Math.min(100, Math.max(0, Math.trunc(row.holdout_pct))), source: "site" };
  }
  return { pct: fallback, source: "default" };
}

const setHoldout = db.prepare("UPDATE sites SET holdout_pct = ? WHERE site = ?");

// null clears the override and the deployment default applies again.
// A missing row is not inserted here. applyCap is the only registration door.
export function saveHoldout(site: string, pct: number | null): { ok: true } | { ok: false; error: "unregistered" } {
  if (!getSite.get(site)) return { ok: false, error: "unregistered" };
  setHoldout.run(pct, site);
  return { ok: true };
}

export type CapResult =
  | { ok: true }
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "site_cap"; cap: number };

export function applyCap(canRegisterSite: boolean, site: string): CapResult {
  if (getSite.get(site)) return { ok: true };
  if (!canRegisterSite) return { ok: false, error: "forbidden" };
  const reg = registerSite(site);
  if (!reg.ok) return { ok: false, error: "site_cap", cap: reg.cap };
  return { ok: true };
}

function registerSite(site: string): { ok: true } | { ok: false; cap: number } {
  if (getSite.get(site)) return { ok: true };
  const cap = (PLANS[DEPLOY_PLAN] ?? PLANS.selfhost!).sites;
  if (cap !== null) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number };
    if (row.n >= cap) return { ok: false, cap };
  }
  insSite.run(site, DEPLOY_PLAN, Date.now());
  return { ok: true };
}
