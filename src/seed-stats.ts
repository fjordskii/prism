// Seed believable demo analytics: 30 days of impressions/conversions per variant
// plus a holdout control arm, with realistic daily noise. Idempotent-ish: wipes
// prior synthetic events (visitor_id LIKE 'syn_%') before inserting.
import { db } from "./db";

const site = "demo";
db.prepare("DELETE FROM events WHERE site = ? AND visitor_id LIKE 'syn_%'").run(site);

const variants = db.prepare("SELECT id, name FROM variants WHERE site = ?").all(site) as { id: number; name: string }[];
// True underlying conversion rates per variant (demo fiction, kept plausible)
const rates: Record<string, number> = {
  "Bundle-buyer hero": 0.11,
  "Gift-buyer hero": 0.13,
  "Returning-customer subscribe strip": 0.09,
  "Woody-first catalog sort": 0.055,
  "Bundle upsell note": 0.045,
};
const CONTROL_RATE = 0.03;
const DAYS = 30;

let vCounter = 0;
const nextVisitor = () => `syn_${(vCounter++).toString(36)}`;
const ins = db.prepare(
  "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES (?, ?, ?, ?, ?, ?)"
);

// deterministic PRNG so reseeds are stable
let s = 42;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const tx = db.transaction(() => {
  const now = Date.now();
  for (const v of variants) {
    const rate = rates[v.name] ?? 0.04;
    const sel = v.name.includes("strip") ? "#pdp-strip" : v.name.includes("sort") || v.name.includes("upsell") ? "#grid" : "#hero";
    for (let d = DAYS; d >= 1; d--) {
      const dayTs = now - d * 86400000;
      const imp = Math.round(30 + 25 * rand() + (DAYS - d) * 0.8); // slight growth trend
      for (let i = 0; i < imp; i++) {
        const vid = nextVisitor();
        ins.run(site, vid, v.id, sel, "impression", dayTs + i * 60000);
        if (rand() < rate) ins.run(site, vid, v.id, sel, "conversion", dayTs + i * 60000 + 45000);
      }
    }
  }
  // holdout control: ~10% of treated volume at baseline rate
  for (let d = DAYS; d >= 1; d--) {
    const dayTs = now - d * 86400000;
    const imp = Math.round(12 + 8 * rand());
    for (let i = 0; i < imp; i++) {
      const vid = nextVisitor();
      ins.run(site, vid, null, "#hero", "impression", dayTs + i * 70000);
      if (rand() < CONTROL_RATE) ins.run(site, vid, null, "#hero", "conversion", dayTs + i * 70000 + 30000);
    }
  }
});
tx();
console.log(`Seeded synthetic analytics: ${vCounter} synthetic visitors over ${DAYS} days`);
