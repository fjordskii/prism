// Prism server: decision API, event ingest, admin dashboard, static demo + snippet.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { db, matchAudience, type Variant, type Rule } from "./db";
import { banditScore } from "./bandit";
import { dashboard } from "./dashboard";

const app = new Hono<{ Variables: { demoBody?: Record<string, unknown> } }>();
app.use("/api/*", cors());

// Admin auth: Bearer token on mutating/admin routes. Set ADMIN_TOKEN in env.
// Public (no auth): /api/identify, /api/decide, /api/events — the snippet's runtime surface.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DEMO_TOKEN = process.env.DEMO_TOKEN; // read-only demo access for prospects
function authorized(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }, allowDemo = false) {
  if (!ADMIN_TOKEN) return true;
  const tok = c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token");
  if (tok === ADMIN_TOKEN) return true;
  if (allowDemo && DEMO_TOKEN && tok === DEMO_TOKEN) return true;
  return false;
}
// Admin token: any site. Demo token: the demo site only (it is published for
// prospects, so it must never read or erase another tenant's data).
function authorizedForSite(c: Parameters<typeof authorized>[0], site: string) {
  if (authorized(c)) return true;
  return site === "demo" && authorized(c, true);
}
app.use("/api/variants*", async (c, next) => {
  if (c.req.method === "GET") return next();
  if (authorized(c)) return next();
  // Demo token may write ONLY to the demo site — prospects must be able to
  // complete the authoring loop during evaluation.
  if (DEMO_TOKEN) {
    const tok = c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token");
    if (tok === DEMO_TOKEN) {
      if (c.req.method === "POST" && c.req.path === "/api/variants") {
        const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
        if (body?.site === "demo") { c.set("demoBody", body); return next(); }
      }
      // toggle/delete allowed only for demo-site variants. Middleware runs before
      // route matching, so extract the id from the path directly.
      const m = c.req.path.match(/^\/api\/variants\/(\d+)/);
      if (m) {
        const v = db.prepare("SELECT site FROM variants WHERE id = ?").get(Number(m[1])) as { site: string } | null;
        if (v?.site === "demo") return next();
      }
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});
// Malformed JSON bodies are a client error, not a 500.
app.onError((err, c) => {
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});
app.use("/admin", async (c, next) => {
  if (!authorized(c, true)) return c.text("Unauthorized. Pass ?token= or an Authorization: Bearer header.", 401);
  return next();
});

// Optional anti-poisoning write key: if SITE_WRITE_KEY is set, snippet calls must carry it.
const WRITE_KEY = process.env.SITE_WRITE_KEY;
app.use("/api/identify", async (c, next) => {
  if (WRITE_KEY && c.req.header("x-prism-key") !== WRITE_KEY) return c.json({ error: "bad write key" }, 401);
  return next();
});
app.use("/api/events", async (c, next) => {
  if (WRITE_KEY && c.req.header("x-prism-key") !== WRITE_KEY) return c.json({ error: "bad write key" }, 401);
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
// Holdout: HOLDOUT_PCT of visitors per selector get control (no variant) but are still
// tracked with variant_id=null so /api/stats can report true incremental lift.
const HOLDOUT_PCT = Number(process.env.HOLDOUT_PCT ?? 10);

app.post("/api/decide", async (c) => {
  const body = await c.req.json<{ visitorId: string; site: string; selectors?: string[] }>();
  if (!body.visitorId || !body.site) return c.json({ error: "visitorId and site required" }, 400);

  const visitor = getVisitor.get(body.visitorId, body.site) as { traits: string } | null;
  const traits: Record<string, unknown> = visitor ? JSON.parse(visitor.traits) : {};
  const now = Date.now();

  const variants = db
    .prepare(
      `SELECT * FROM variants WHERE site = ? AND active = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at > ?)`
    )
    .all(body.site, now, now) as Variant[];

  const bySelector = new Map<string, Variant[]>();
  for (const v of variants) {
    if (body.selectors?.length && !body.selectors.includes(v.selector)) continue;
    const rules = JSON.parse(v.audience) as Rule[];
    if (!matchAudience(rules, traits)) continue;
    bySelector.set(v.selector, [...(bySelector.get(v.selector) ?? []), v]);
  }

  // Deterministic holdout per visitor+selector so a visitor doesn't flip in/out.
  const holdout = (selector: string) => {
    let h = 0;
    const s = body.visitorId + ":" + selector;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 100 < HOLDOUT_PCT;
  };

  const decisions: { selector: string; variantId: number | null; name: string; ops: unknown[]; control?: boolean }[] = [];
  for (const [selector, cands] of bySelector) {
    if (holdout(selector)) {
      decisions.push({ selector, variantId: null, name: "control", ops: [], control: true });
      continue;
    }
    const scored = cands.map((v) => ({ v, s: banditScore(v.id, v.weight) }));
    scored.sort((a, b) => b.s - a.s);
    const winner = scored[0]!.v;
    decisions.push({ selector, variantId: winner.id, name: winner.name, ops: JSON.parse(winner.ops) });
  }

  return c.json({ decisions, traits });
});

// ---------- events ----------
// Integrity: a conversion is only recorded if this visitor has an impression for the
// same variant+selector (or a control impression for control conversions) — kills
// orphaned conversions and most casual poisoning. Unknown event types are dropped.
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
  const hasImp = db.prepare(
    `SELECT 1 FROM events WHERE site = ? AND visitor_id = ? AND selector = ?
     AND type = 'impression' AND (variant_id IS ? OR variant_id = ?) LIMIT 1`
  );
  const now = Date.now();
  let recorded = 0;
  const tx = db.transaction(() => {
    for (const e of body.events) {
      if (!e || (e.type !== "impression" && e.type !== "conversion") || typeof e.selector !== "string") continue;
      const variantId = e.variantId ?? null;
      if (e.type === "conversion") {
        if (!hasImp.get(body.site, body.visitorId, e.selector, variantId, variantId)) continue;
      }
      stmt.run(body.site, body.visitorId, variantId, e.selector, e.type, now);
      recorded++;
    }
  });
  tx();
  return c.json({ ok: true, recorded });
});

app.get("/api/sites", (c) => {
  const rows = db.prepare("SELECT DISTINCT site FROM variants UNION SELECT DISTINCT site FROM events UNION SELECT DISTINCT site FROM visitors").all() as { site: string }[];
  return c.json(rows.map((r) => r.site));
});
// ---------- admin CRUD ----------
app.get("/api/variants", (c) => {
  const site = c.req.query("site") ?? "demo";
  return c.json(db.prepare("SELECT * FROM variants WHERE site = ? ORDER BY id").all(site));
});

app.post("/api/variants", async (c) => {
  // Body may already be parsed by the demo-token middleware (JSON bodies are single-read).
  const b = (c.get("demoBody") ?? await c.req.json().catch(() => ({}))) as Partial<Variant> & { site: string; name: string; selector: string };
  if (!b.site || !b.name || !b.selector) return c.json({ error: "site, name, selector required" }, 400);
  const r = db
    .prepare(
      `INSERT INTO variants (site, name, selector, ops, audience, weight, starts_at, ends_at, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.site, b.name, b.selector, b.ops ?? "[]", b.audience ?? "[]",
      b.weight ?? 1, b.starts_at ?? null, b.ends_at ?? null, b.active ?? 1, Date.now()
    );
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

// ---------- stats ----------
// Wilson score interval (95%) so rates come with honest uncertainty.
function wilson(conv: number, imp: number): [number, number] | null {
  if (imp === 0) return null;
  const z = 1.96, p = conv / imp;
  const denom = 1 + (z * z) / imp;
  const center = (p + (z * z) / (2 * imp)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * imp)) / imp)) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

app.get("/api/stats", (c) => {
  const site = c.req.query("site") ?? "demo";
  const rows = db
    .prepare(
      `SELECT v.id, v.name, v.selector, v.active, v.starts_at, v.ends_at,
              COALESCE(SUM(e.type='impression'), 0) AS impressions,
              COALESCE(SUM(e.type='conversion'), 0) AS conversions
       FROM variants v LEFT JOIN events e ON e.variant_id = v.id
       WHERE v.site = ? GROUP BY v.id ORDER BY v.id`
    )
    .all(site) as { id: number; name: string; selector: string; active: number; starts_at: number | null; ends_at: number | null; impressions: number; conversions: number }[];

  const control = db
    .prepare(
      `SELECT COALESCE(SUM(type='impression'),0) AS impressions,
              COALESCE(SUM(type='conversion'),0) AS conversions
       FROM events WHERE site = ? AND variant_id IS NULL`
    )
    .get(site) as { impressions: number; conversions: number };

  const withCI = rows.map((r) => ({
    ...r,
    rate: r.impressions ? r.conversions / r.impressions : null,
    ci95: wilson(r.conversions, r.impressions),
  }));
  return c.json({
    variants: withCI,
    control: {
      ...control,
      rate: control.impressions ? control.conversions / control.impressions : null,
      ci95: wilson(control.conversions, control.impressions),
    },
    holdoutPct: HOLDOUT_PCT,
  });
});

// ---------- export / DSR ----------
app.get("/api/export", (c) => {
  const site = c.req.query("site") ?? "demo";
  if (!authorizedForSite(c, site)) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    site,
    exportedAt: new Date().toISOString(),
    variants: db.prepare("SELECT * FROM variants WHERE site = ?").all(site),
    events: db.prepare("SELECT * FROM events WHERE site = ? ORDER BY ts").all(site),
    visitors: db.prepare("SELECT * FROM visitors WHERE site = ?").all(site),
  });
});

// GDPR/CCPA: export or erase one visitor across visitors+events. Token-gated —
// these read/destroy PII-adjacent data, so they use the same auth as /admin.
app.use("/api/visitors/*", async (c, next) => {
  if (!authorizedForSite(c, c.req.query("site") ?? "demo")) return c.json({ error: "unauthorized" }, 401);
  return next();
});
app.get("/api/visitors/:id", (c) => {
  const site = c.req.query("site") ?? "demo";
  return c.json({
    visitor: getVisitor.get(c.req.param("id"), site) ?? null,
    events: db.prepare("SELECT * FROM events WHERE visitor_id = ? AND site = ?").all(c.req.param("id"), site),
  });
});
app.delete("/api/visitors/:id", (c) => {
  const site = c.req.query("site") ?? "demo";
  const id = c.req.param("id");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE visitor_id = ? AND site = ?").run(id, site);
    db.prepare("DELETE FROM visitors WHERE id = ? AND site = ?").run(id, site);
  });
  tx(); // the erasure must actually run
  return c.json({ ok: true, deleted: id });
});

// ---------- trust pages ----------
const trustPage = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}: Prism</title>
<style>body{font:15px/1.7 -apple-system,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#1a1a1a}h1{font-size:24px}h2{font-size:17px;margin-top:28px}code{background:#f0f0ec;padding:1px 5px;border-radius:4px}</style></head>
<body><h1>${title}</h1>${body}<p style="margin-top:40px;color:#777"><a href="/">Prism</a> · <a href="/demo/">Demo</a> · <a href="/privacy">Privacy</a> · <a href="/security">Security</a> · <a href="/terms">Terms</a></p></body></html>`;

app.get("/privacy", (c) =>
  c.html(
    trustPage(
      "Privacy",
      `<h2>What we store</h2>
<p>For each visitor: a random ID in a first-party cookie (<code>prism_vid</code>, SameSite=Lax, 400 days), visit counts, and any traits the site explicitly sends through <code>prism.identify()</code>. For each event: the variant shown, the selector, whether it was an impression or conversion, and a timestamp.</p>
<h2>What we never do</h2>
<p>We don't fingerprint browsers, set third-party cookies, or track visitors across sites. Visitor data is never sold or shared. Events stay in the site's own first-party context.</p>
<h2>Your rights (GDPR / CCPA)</h2>
<p>Export one visitor: <code>GET /api/visitors/:id?site=…</code>. Erase one visitor: <code>DELETE /api/visitors/:id?site=…</code>, which removes their profile and every event. Both endpoints require the same Bearer token as the dashboard. Full site export: <code>GET /api/export?site=…</code> (also token-gated).</p>
<h2>Retention &amp; subprocessors</h2>
<p>Data lives in SQLite on Fly.io (US, iad region) with daily volume snapshots. The only subprocessor is Fly.io. Contact: privacy@sundaymorning.software.</p>`
    )
  )
);

app.get("/security", (c) =>
  c.html(
    trustPage(
      "Security",
      `<h2>Serving model</h2>
<p>The 9 KB snippet (3 KB gzipped) loads with <code>defer</code>, applies changes after first paint, and wraps every DOM operation in try/catch. If Prism is unreachable, visitors see your default page. Nothing in the request path runs a model or third-party code. Insert-style variants are idempotent: re-applied operations replace, never duplicate.</p>
<h2>Access control</h2>
<p>Variant writes, the dashboard, exports, and privacy endpoints require a Bearer token. An optional per-site write key (<code>SITE_WRITE_KEY</code>) locks identify and event ingestion against poisoning. For supply-chain control, self-host the snippet from your own domain (<code>data-host</code>) or pin the versioned immutable URL <code>/snippet.v1.js</code>.</p>
<h2>Data integrity</h2>
<p>Conversions are only recorded for visitors with a matching prior impression. Stats ship with 95% Wilson confidence intervals. A deterministic holdout arm (default 10% per selector) preserves a control group for true incremental lift.</p>
<h2>Data flows</h2>
<p>Browser to Prism API (HTTPS only, HSTS via the Fly edge) to SQLite on an encrypted Fly volume. No data leaves that path. Privacy endpoints are documented at <a href="/privacy">/privacy</a>.</p>`
    )
  )
);

app.get("/terms", (c) =>
  c.html(
    trustPage(
      "Terms",
      `<h2>Service</h2>
<p>Prism provides client-side website personalization as hosted software. Plans: Shadow ($0, 10k visitors/mo, tracking only), Growth ($79/mo, 100k visitors/mo, 3 sites), Pro ($179/mo, 500k visitors/mo, 5 sites), Agency ($299/mo, 1M visitors/mo, unlimited sites, white-label).</p>
<h2>Billing</h2>
<p>Annual prepay: 2 months free (pay 10, get 12). Renewal price locked for 12 months. Overage: service continues and we contact you to right-size before any charge. Cancel anytime. You keep a full data export (<code>/api/export</code>).</p>
<h2>Availability</h2>
<p>SLA on paid plans: 99.9% monthly uptime, measured at the Fly edge. Miss it and you get a service credit of 10x the downtime (1 hour down = 10 hours credited), applied automatically. Shadow is best-effort. The snippet fails open: any Prism outage means your visitors see your default site, never an error.</p>
<h2>Liability</h2>
<p>You approve every variant. Prism never generates visitor-facing content at request time. Standard SaaS liability cap: fees paid in the trailing 12 months.</p>`
    )
  )
);

// ---------- dashboard + static ----------
// Versioned immutable snippet for SRI pinning / supply-chain control.
// Hash printed at startup; pin it in your CSP/integrity attribute.
app.use("/snippet.v1.js", async (c, next) => {
  await next();
  c.header("cache-control", "public, max-age=31536000, immutable");
});
app.use("/snippet.v1.js", serveStatic({ path: "./public/snippet.js" }));
app.get("/admin", (c) => c.html(dashboard()));
// Snippet: long cache + immutable-ish; it only changes on deploy, and cache-bust via ?v= if needed.
app.use("/snippet.js", async (c, next) => {
  await next();
  c.header("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
});
app.use("/snippet.js", serveStatic({ path: "./public/snippet.js" }));
app.use("/landing/*", serveStatic({ root: "./landing", rewriteRequestPath: (p) => p.replace(/^\/landing/, "") || "/index.html" }));
app.get("/landing", (c) => c.redirect("/"));
app.use("/demo/*", serveStatic({ root: "./demo", rewriteRequestPath: (p) => p.replace(/^\/demo/, "") || "/index.html" }));
app.get("/demo", (c) => c.redirect("/demo/"));
// Root = the selling lander.
app.get("/", serveStatic({ path: "./landing/index.html" }));

export default app;
