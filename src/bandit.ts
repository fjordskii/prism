// Thompson sampling over Beta(impressions-conversions+1... ) — classic Bernoulli bandit.
// alpha = conversions + 1, beta = impressions - conversions + 1.
import { db } from "./db";

function sampleBeta(alpha: number, beta: number): number {
  // Joehnk's algorithm is overkill; use gamma-ratio: X/(X+Y), X~Gamma(a), Y~Gamma(b)
  const g = (shape: number): number => {
    if (shape < 1) return g(shape + 1) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = 0, v = 0;
      do { x = randn(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x ** 4) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = g(alpha), y = g(beta);
  return x / (x + y);
}

let spare: number | null = null;
function randn(): number {
  if (spare !== null) { const s = spare; spare = null; return s; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}

const statsStmt = db.prepare(
  `SELECT
     SUM(type='impression') AS impressions,
     SUM(type='conversion') AS conversions
   FROM events WHERE variant_id = ?`
);

export function banditScore(variantId: number, weight: number): number {
  const row = statsStmt.get(variantId) as { impressions: number | null; conversions: number | null };
  const imp = row.impressions ?? 0;
  const conv = row.conversions ?? 0;
  return sampleBeta(conv + weight, imp - conv + 1);
}
