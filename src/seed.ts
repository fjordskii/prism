// Seed demo variants mirroring the ION Dynamite demo personas.
import { db } from "./db";

const site = "demo";
db.prepare("DELETE FROM variants WHERE site = ?").run(site);

const variants = [
  {
    name: "Bundle-buyer hero",
    selector: "#hero",
    audience: [{ field: "cartItems", op: "gte", value: 3 }],
    ops: [{
      op: "html",
      html: `<small style="letter-spacing:.2em;text-transform:uppercase;color:#8a8175">Any three for $108</small>
<h1>Three scents. One calm home.</h1>
<p>Build a bundle of your three favorites and save $24 on the set.</p>
<a class="btn" href="#grid" data-prism-convert="#hero">Build my bundle</a>`,
    }],
  },
  {
    name: "Gift-buyer hero",
    selector: "#hero",
    audience: [{ field: "intent", op: "eq", value: "gift" }],
    ops: [{
      op: "html",
      html: `<small style="letter-spacing:.2em;text-transform:uppercase;color:#8a8175">Gift-wrapped, free</small>
<h1>The gift that fills a room.</h1>
<p>Three hand-poured scents in a linen box. Ready to give, from $108.</p>
<a class="btn" href="#grid" data-prism-convert="#hero">Shop gift sets</a>`,
    }],
  },
  {
    name: "Returning-customer subscribe strip",
    selector: "#pdp-strip",
    audience: [{ field: "orders", op: "gte", value: 1 }],
    ops: [
      { op: "insertAfter", html: `<div style="background:#fff;border:1px solid #d9cfbc;padding:20px 24px;margin-top:16px;border-radius:6px" data-prism-convert="#pdp-strip">
<strong>Welcome back.</strong> Subscribe &amp; save 15% — every 8 weeks, $35.70.
<button class="btn" style="margin-left:16px" onclick="prism.convert('#pdp-strip');toast('Subscribed!')">Start subscription</button></div>` },
    ],
  },
  {
    name: "Woody-first catalog sort",
    selector: "#grid",
    audience: [{ field: "affinity", op: "eq", value: "woody" }],
    ops: [{ op: "reorder", order: ["[data-scent=fig]", "[data-scent=pepper]", "[data-scent=sandal]", "[data-scent=orange]", "[data-scent=seasalt]", "[data-scent=vanilla]"] }],
  },
  {
    name: "Bundle upsell note",
    selector: "#grid",
    audience: [{ field: "cartItems", op: "gte", value: 3 }],
    ops: [{ op: "insertBefore", html: `<p style="grid-column:1/-1;background:#2b2620;color:#faf8f4;padding:12px 18px;border-radius:6px;text-align:center">Bundle &amp; save — your three, for $108. Save $24.</p>` }],
  },
];

const stmt = db.prepare(
  "INSERT INTO variants (site, name, selector, ops, audience, weight, active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)"
);
for (const v of variants) {
  stmt.run(site, v.name, v.selector, JSON.stringify(v.ops), JSON.stringify(v.audience), Date.now());
}
console.log(`Seeded ${variants.length} variants for site "${site}"`);
