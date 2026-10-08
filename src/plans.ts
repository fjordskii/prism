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

const getSite = db.prepare("SELECT plan FROM sites WHERE site = ?");
const insSite = db.prepare("INSERT OR IGNORE INTO sites (site, plan, created_at) VALUES (?, ?, ?)");

// Read-only: unknown sites report the deployment plan WITHOUT being registered.
// Only registerSite() and the admin plan endpoint may insert — otherwise
// /api/decide or /api/stats would bypass the site cap.
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

// Register a never-seen site unless the deployment plan's site cap is reached.
export function registerSite(site: string): { ok: true } | { ok: false; cap: number } {
  if (getSite.get(site)) return { ok: true };
  const cap = (PLANS[DEPLOY_PLAN] ?? PLANS.selfhost!).sites;
  if (cap !== null) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sites").get() as { n: number };
    if (row.n >= cap) return { ok: false, cap };
  }
  insSite.run(site, DEPLOY_PLAN, Date.now());
  return { ok: true };
}
