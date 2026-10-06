// Prism server: decision API, event ingest, admin dashboard, static demo + snippet.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { db, matchAudience, type Variant, type Rule } from "./db";
import { banditScore } from "./bandit";
import { dashboard } from "./dashboard";

const app = new Hono();
app.use("/api/*", cors());

// Admin auth: Bearer token on mutating/admin routes. Set ADMIN_TOKEN in env.
// Public (no auth): /api/identify, /api/decide, /api/events — the snippet's runtime surface.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
app.use("/api/variants*", async (c, next) => {
  if (c.req.method === "GET") return next(); // read-only listing stays open for the dashboard demo
  if (!ADMIN_TOKEN) return next();           // local dev without token = open
  if (c.req.header("authorization") !== `Bearer ${ADMIN_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
  return next();
});
app.use("/admin", async (c, next) => {
  if (!ADMIN_TOKEN) return next();
  const ok = c.req.header("authorization") === `Bearer ${ADMIN_TOKEN}` || c.req.query("token") === ADMIN_TOKEN;
  if (!ok) return c.text("Unauthorized — pass ?token= or an Authorization: Bearer header.", 401);
  return next();
});

// ---------- visitor upsert ----------
const getVisitor = db.prepare("SELECT * FROM visitors WHERE id = ? AND site = ?");
const insVisitor = db.prepare(
  `INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits)
   VALUES (?, ?, ?, ?, 1, ?)
   ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, visits = visits + 1`
);
const updTraits = db.prepare("UPDATE visitors SET traits = ? WHERE id = ? AND site = ?");

app.post("/api/identify", async (c) => {
  const body = await c.req.json<{ visitorId: string; site: string; traits?: Record<string, unknown> }>();
  if (!body.visitorId || !body.site) return c.json({ error: "visitorId and site required" }, 400);
  const now = Date.now();
  const existing = getVisitor.get(body.visitorId, body.site) as { traits: string } | null;
  const traits = { ...(existing ? JSON.parse(existing.traits) : {}), ...(body.traits ?? {}) };
  if (existing) updTraits.run(JSON.stringify(traits), body.visitorId, body.site);
  else insVisitor.run(body.visitorId, body.site, now, now, JSON.stringify(traits));
  return c.json({ ok: true });
});

// ---------- decision ----------
app.post("/api/decide", async (c) => {
  const body = await c.req.json<{ visitorId: string; site: string; selectors?: string[] }>();
  if (!body.visitorId || !body.site) return c.json({ error: "visitorId and site required" }, 400);

  const visitor = getVisitor.get(body.visitorId, body.site) as { traits: string } | null;
  const traits: Record<string, unknown> = visitor ? JSON.parse(visitor.traits) : {};

  const variants = db
    .prepare("SELECT * FROM variants WHERE site = ? AND active = 1")
    .all(body.site) as Variant[];

  // Group by selector; within each selector pick the best-matching variant by bandit score.
  const bySelector = new Map<string, Variant[]>();
  for (const v of variants) {
    if (body.selectors?.length && !body.selectors.includes(v.selector)) continue;
    const rules = JSON.parse(v.audience) as Rule[];
    if (!matchAudience(rules, traits)) continue;
    bySelector.set(v.selector, [...(bySelector.get(v.selector) ?? []), v]);
  }

  const decisions = [...bySelector.entries()].map(([selector, cands]) => {
    const scored = cands.map((v) => ({ v, s: banditScore(v.id, v.weight) }));
    scored.sort((a, b) => b.s - a.s);
    const winner = scored[0]!.v;
    return { selector, variantId: winner.id, name: winner.name, ops: JSON.parse(winner.ops) };
  });

  return c.json({ decisions, traits });
});

// ---------- events ----------
app.post("/api/events", async (c) => {
  const body = await c.req.json<{
    site: string;
    visitorId: string;
    events: { variantId: number | null; selector: string; type: "impression" | "conversion" }[];
  }>();
  if (!body.site || !body.visitorId || !Array.isArray(body.events)) return c.json({ error: "bad payload" }, 400);
  const stmt = db.prepare(
    "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const e of body.events) stmt.run(body.site, body.visitorId, e.variantId, e.selector, e.type, now);
  });
  tx();
  return c.json({ ok: true, recorded: body.events.length });
});

// ---------- admin CRUD ----------
app.get("/api/variants", (c) => {
  const site = c.req.query("site") ?? "demo";
  return c.json(db.prepare("SELECT * FROM variants WHERE site = ? ORDER BY id").all(site));
});

app.post("/api/variants", async (c) => {
  const b = await c.req.json<Partial<Variant> & { site: string; name: string; selector: string }>();
  if (!b.site || !b.name || !b.selector) return c.json({ error: "site, name, selector required" }, 400);
  const r = db
    .prepare("INSERT INTO variants (site, name, selector, ops, audience, weight, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(b.site, b.name, b.selector, b.ops ?? "[]", b.audience ?? "{}", b.weight ?? 1, b.active ?? 1, Date.now());
  return c.json({ id: r.lastInsertRowid }, 201);
});

app.post("/api/variants/:id/toggle", (c) => {
  db.prepare("UPDATE variants SET active = 1 - active WHERE id = ?").run(c.req.param("id"));
  return c.json({ ok: true });
});

app.delete("/api/variants/:id", (c) => {
  db.prepare("DELETE FROM variants WHERE id = ?").run(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/stats", (c) => {
  const site = c.req.query("site") ?? "demo";
  const rows = db
    .prepare(
      `SELECT v.id, v.name, v.selector, v.active,
              SUM(e.type='impression') AS impressions,
              SUM(e.type='conversion') AS conversions
       FROM variants v LEFT JOIN events e ON e.variant_id = v.id
       WHERE v.site = ? GROUP BY v.id ORDER BY v.id`
    )
    .all(site);
  return c.json(rows);
});

// ---------- dashboard + static ----------
app.get("/admin", (c) => c.html(dashboard()));
// Snippet: long cache + immutable-ish; it only changes on deploy, and cache-bust via ?v= if needed.
app.use("/snippet.js", async (c, next) => {
  await next();
  c.header("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
});
app.use("/snippet.js", serveStatic({ path: "./public/snippet.js" }));
app.use("/landing/*", serveStatic({ root: "./landing", rewriteRequestPath: (p) => p.replace(/^\/landing/, "") || "/index.html" }));
app.get("/landing", (c) => c.redirect("/landing/"));
app.use("/*", serveStatic({ root: "./demo" }));

export default app;
