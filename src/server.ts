// Prism server: decision API, event ingest, admin dashboard, static demo + snippet.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/bun";
import { db, matchAudience, type Variant, type Rule } from "./db";
import { parseOrder, reportArm } from "./money";
import { banditScore } from "./bandit";
import { dashboard } from "./dashboard";
import { architecture } from "./architecture";
import { PLANS, sitePlan, usageFor, registerSite, holdoutFor, saveHoldout } from "./plans";
import { audienceKey, defaultHoldoutPct, isHoldout, pickExperience } from "./holdout";
import { wilson, REPORT_NOTE } from "./lift";
import { buildExperiences, renderLiftCsv, renderLiftHtml, type LiftReport } from "./experiences";
import {
  oauthEnabled, DEV_EMAIL, SESSION_COOKIE, loginPage,
  accountRole, sessionEmail, makeSession, googleAuthUrl, exchangeCode, verifyGoogleIdToken,
} from "./auth";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { windowCounter, clientIp } from "./ratelimit";
import { applyOffers, billingDecision, parsePilotInquiry, pilotPage, type PayView } from "./offer";

// Real SRI hash of the snippet, printed so operators can pin it in CSP/integrity.
const snippetSri = new Bun.CryptoHasher("sha384").update(await Bun.file("public/snippet.js").arrayBuffer()).digest("base64");
console.log("snippet.v1.js SRI: sha384-" + snippetSri);

const app = new Hono<{ Variables: { demoBody?: Record<string, unknown> } }>();
app.use("/api/*", cors());
// Malformed JSON bodies are a client error, not a 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Admin auth: Bearer token or session on mutating routes, the dashboard, and catalog reads.
// Public (no auth): /api/identify, /api/decide, /api/events, and the snippet files.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// TODO: rotate by setting the Fly secret DEMO_TOKEN to a new value
// (`fly secrets set DEMO_TOKEN=...`). This historical literal is the default
// only when that env var is unset; once the secret is set, the literal is ignored.
const DEMO_TOKEN = process.env.DEMO_TOKEN || "demo-panel-2026";
// Read-only tokens: GET routes, /admin, /api/export, GET /api/visitors/:id — never mutations.
const READONLY_TOKENS: Record<string, true> = Object.fromEntries(
  (process.env.READONLY_TOKENS ?? "").split(",").filter(Boolean).map((t) => [t, true])
);
type AuthReq = { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } };
function requestToken(c: AuthReq) {
  return c.req.header("authorization")?.replace(/^Bearer /, "") ?? c.req.query("token");
}
function demoTokenMatches(c: AuthReq) {
  const tok = requestToken(c);
  return Boolean(DEMO_TOKEN) && tok === DEMO_TOKEN;
}
// Session cookie (Google OAuth) takes precedence for browsers; Bearer/query tokens
// remain the agent/operator path. Open mode only when NO auth is configured at all.
async function authorized(c: AuthReq, allowDemo = false, allowReadonly = false) {
  const email = await sessionEmail(getCookie(c as never)[SESSION_COOKIE]);
  if (email) {
    const role = accountRole(email);
    if (role === "owner" || role === "editor") return true;
    if (role === "viewer") return allowReadonly;
  }
  if (!ADMIN_TOKEN && !oauthEnabled) return true;
  const tok = requestToken(c);
  if (tok === ADMIN_TOKEN && ADMIN_TOKEN) return true;
  if (allowDemo && DEMO_TOKEN && tok === DEMO_TOKEN) return true;
  if (allowReadonly && tok !== undefined && Object.hasOwn(READONLY_TOKENS, tok)) return true;
  return false;
}
// Admin token or an owner/editor session: any site. Demo token: the demo site
// only (it is handed to prospects, so it must never read or erase another tenant).
// Readonly tokens and viewer sessions: reads on any site of this deployment.
// Google accounts stay deployment-wide; the demo token is the site-scoped credential.
async function authorizedForSite(c: AuthReq, site: string, opts?: { write?: boolean }) {
  if (await authorized(c)) return true;
  if (site === "demo" && demoTokenMatches(c)) return true;
  if (!opts?.write && (await authorized(c, false, true))) return true;
  return false;
}
// Plan changes are billing-adjacent: admin token or an owner session, never editor/viewer/demo.
async function fullAdmin(c: AuthReq) {
  const email = await sessionEmail(getCookie(c as never)[SESSION_COOKIE]);
  if (email && accountRole(email) === "owner") return true;
  if (!ADMIN_TOKEN && !oauthEnabled) return true;
  const tok = requestToken(c);
  return Boolean(ADMIN_TOKEN) && tok === ADMIN_TOKEN;
}
app.use("/api/variants*", async (c, next) => {
  if (c.req.method === "GET") {
    const site = c.req.query("site") ?? "demo";
    if (await authorizedForSite(c, site)) return next();
    return c.json({ error: "unauthorized" }, 401);
  }
  if (await authorized(c)) return next();
  // Demo token may write ONLY to the demo site — prospects must be able to
  // complete the authoring loop during evaluation.
  if (demoTokenMatches(c)) {
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
  return c.json({ error: "unauthorized" }, 401);
});
app.use("/admin", async (c, next) => {
  if (await authorized(c, true, true)) return next();
  if (oauthEnabled) return c.redirect("/auth/login");
  return c.text("Unauthorized. Pass ?token= or an Authorization: Bearer header.", 401);
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
   ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, visits = visits + 1
   WHERE visitors.site = excluded.site`
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
// Each audience on a selector has its own holdout. The hash is visitor + selector
// + audience, so a visitor does not flip arms on later requests. HOLDOUT_PCT is
// the deployment default. A site row can override it.
// The bandit read is still one indexed aggregate per candidate variant. The
// audience predicate stays on that variant_id range. Decide does not scan the
// events table.

// Metering: decide counts visitors even before first identify, so usage is honest.
// Only registered sites are metered (a sites row from registerSite / the plan
// endpoint / seed, or existing variants), so made-up site names write nothing.
const insMeter = db.prepare("INSERT OR IGNORE INTO visitors (id, site, first_seen, last_seen, traits) VALUES (?,?,?,?,'{}')");
const touchMeter = db.prepare("UPDATE visitors SET last_seen = ? WHERE id = ? AND site = ?");
const knownSite = db.prepare("SELECT 1 FROM sites WHERE site = ? UNION ALL SELECT 1 FROM variants WHERE site = ? LIMIT 1");

// Abuse limits (per client IP + site). The request cap answers 429 with empty
// decisions so the snippet fails open; the new-visitor cap stops one client from
// inflating a tenant's metered visitor count with random visitor ids (over the cap
// the decision is still served, the visitor just isn't metered).
const DECIDE_PER_MIN = Number(process.env.DECIDE_RATE_PER_MIN ?? 600);
const NEW_VISITORS_PER_HOUR = Number(process.env.DECIDE_NEW_VISITORS_PER_HOUR ?? 120);
const decideRate = windowCounter(DECIDE_PER_MIN, 60_000);
const newVisitorRate = windowCounter(NEW_VISITORS_PER_HOUR, 3_600_000);
const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

app.post("/api/decide", async (c) => {
  const body = await c.req.json<{ visitorId: string; site: string; selectors?: string[] }>();
  if (!body || typeof body.visitorId !== "string" || typeof body.site !== "string" || !body.visitorId || !body.site)
    return c.json({ error: "visitorId and site required", decisions: [] }, 400);
  if (body.visitorId.length > 128 || !SITE_RE.test(body.site))
    return c.json({ error: "invalid visitorId or site", decisions: [] }, 400);

  const bucket = clientIp((n) => c.req.header(n)) + "|" + body.site;
  if (!decideRate.hit(bucket)) return c.json({ error: "rate_limited", decisions: [] }, 429);

  // Unregistered site: nothing to personalize and nothing to meter. Same shape as
  // a registered site with no matching variant, so site existence isn't revealed.
  if (!knownSite.get(body.site, body.site)) return c.json({ decisions: [], traits: {} });

  // Plan and usage are tenant data: only for callers allowed to read this site.
  const canRead = await authorizedForSite(c, body.site);

  const now = Date.now();
  let visitor = getVisitor.get(body.visitorId, body.site) as { traits: string } | null;
  if (visitor) touchMeter.run(now, body.visitorId, body.site);
  else if (newVisitorRate.under(bucket) && insMeter.run(body.visitorId, body.site, now, now).changes > 0) {
    newVisitorRate.hit(bucket);
    visitor = getVisitor.get(body.visitorId, body.site) as { traits: string } | null;
  }
  const traits: Record<string, unknown> = visitor ? JSON.parse(visitor.traits) : {};

  // Plan enforcement: fail soft — tracking continues, personalization stops.
  const { plan, def } = sitePlan(body.site);
  const usage = usageFor(body.site);
  if (!def.personalize || usage.overLimit) {
    return c.json(canRead ? { decisions: [], traits, shadow: true, plan, usage } : { decisions: [], traits });
  }

  const variants = db
    .prepare(
      `SELECT * FROM variants WHERE site = ? AND active = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at > ?)`
    )
    .all(body.site, now, now) as Variant[];

  const experiences = new Map<string, { selector: string; key: string; cands: Variant[] }>();
  for (const v of variants) {
    if (body.selectors?.length && !body.selectors.includes(v.selector)) continue;
    let rules: Rule[] = [];
    try {
      const parsed = JSON.parse(v.audience) as unknown;
      if (Array.isArray(parsed)) rules = parsed as Rule[];
    } catch {
      continue;
    }
    if (!matchAudience(rules, traits)) continue;
    const key = audienceKey(v.audience);
    const id = v.selector + "\0" + key;
    const exp = experiences.get(id) ?? { selector: v.selector, key, cands: [] };
    exp.cands.push(v);
    experiences.set(id, exp);
  }

  const bySelector = new Map<string, { selector: string; key: string; cands: Variant[] }[]>();
  for (const exp of experiences.values()) {
    bySelector.set(exp.selector, [...(bySelector.get(exp.selector) ?? []), exp]);
  }

  const holdoutPct = holdoutFor(body.site, defaultHoldoutPct()).pct;
  const decisions: { selector: string; variantId: number | null; name: string; ops: unknown[]; control?: boolean; audienceKey: string }[] = [];
  for (const [selector, exps] of bySelector) {
    const chosenKey = pickExperience(body.visitorId, selector, exps.map((e) => e.key));
    const chosen = exps.find((e) => e.key === chosenKey) ?? exps[0]!;
    if (isHoldout(body.visitorId, selector, chosen.key, holdoutPct)) {
      decisions.push({ selector, variantId: null, name: "control", ops: [], control: true, audienceKey: chosen.key });
      continue;
    }
    const scored = chosen.cands.map((v) => ({ v, s: banditScore(v.id, v.weight, chosen.key) }));
    scored.sort((a, b) => b.s - a.s);
    const winner = scored[0]!.v;
    decisions.push({ selector, variantId: winner.id, name: winner.name, ops: JSON.parse(winner.ops), audienceKey: chosen.key });
  }

  return c.json(canRead ? { decisions, traits, plan, usage } : { decisions, traits });
});

// ---------- events ----------
// A conversion is recorded only when this visitor has an impression for the same
// variant and selector, or a control impression for a control conversion.
// An order is one row per site and order id. It is credited to every arm this
// visitor has already seen on the site. A later impression does not pick it up.
// Unknown event types are dropped. Malformed JSON is a 400 via the app error handler.
const insertEvent = db.prepare(
  "INSERT INTO events (site, visitor_id, variant_id, selector, type, ts, audience_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const hasImp = db.prepare(
  `SELECT 1 FROM events WHERE site = ? AND visitor_id = ? AND selector = ?
   AND type = 'impression' AND (variant_id IS ? OR variant_id = ?) LIMIT 1`
);
const hasImpKeyed = db.prepare(
  `SELECT 1 FROM events WHERE site = ? AND visitor_id = ? AND selector = ?
   AND type = 'impression' AND (variant_id IS ? OR variant_id = ?) AND audience_key = ? LIMIT 1`
);
const insertOrder = db.prepare(
  "INSERT OR IGNORE INTO orders (site, order_id, visitor_id, currency, value_minor, ts) VALUES (?, ?, ?, ?, ?, ?)"
);
const insertCredit = db.prepare("INSERT OR IGNORE INTO order_credits (site, order_id, arm) VALUES (?, ?, ?)");
const orderArms = db.prepare(
  `SELECT DISTINCT CASE
     WHEN variant_id IS NULL AND audience_key IS NOT NULL THEN 'control:' || audience_key
     WHEN variant_id IS NULL THEN 'control'
     ELSE CAST(variant_id AS TEXT)
   END AS arm
   FROM events WHERE site = ? AND visitor_id = ? AND type = 'impression'`
);

app.post("/api/events", async (c) => {
  const body = await c.req.json<{
    site: string;
    visitorId: string;
    events: { variantId?: number | null; selector?: string; type?: string; audienceKey?: unknown; orderId?: unknown; value?: unknown; currency?: unknown }[];
  }>();
  if (!body.site || !body.visitorId || !Array.isArray(body.events)) return c.json({ error: "bad payload" }, 400);
  let recorded = 0;
  let duplicates = 0;
  const rejected: { index: number; field: string; message: string }[] = [];
  const dropped: { index: number; reason: string }[] = [];
  const tx = db.transaction(() => {
    body.events.forEach((e, index) => {
      if (!e || typeof e !== "object") return;
      if (e.type === "order") {
        const parsed = parseOrder(e);
        if (!parsed.ok) {
          rejected.push({ index, field: parsed.field, message: parsed.message });
          return;
        }
        const arms = orderArms.all(body.site, body.visitorId) as { arm: string }[];
        if (arms.length === 0) {
          dropped.push({ index, reason: "no impression" });
          return;
        }
        if (insertOrder.run(body.site, parsed.order.orderId, body.visitorId, parsed.order.currency, parsed.order.valueMinor, Date.now()).changes === 0) {
          duplicates++;
          return;
        }
        const credited = new Set<string>();
        for (const a of arms) {
          if (credited.has(a.arm)) continue;
          credited.add(a.arm);
          insertCredit.run(body.site, parsed.order.orderId, a.arm);
          // Pooled stats still read arm "control". An audience-specific control
          // credit is extra, so the same order shows in that audience and in the pool.
          if (a.arm.startsWith("control:") && !credited.has("control")) {
            credited.add("control");
            insertCredit.run(body.site, parsed.order.orderId, "control");
          }
        }
        recorded++;
        return;
      }
      if ((e.type !== "impression" && e.type !== "conversion") || typeof e.selector !== "string") return;
      const variantId = e.variantId ?? null;
      const rawKey = typeof e.audienceKey === "string" && e.audienceKey.length <= 500 ? e.audienceKey : null;
      if (e.type === "conversion") {
        const keyed = rawKey ? hasImpKeyed.get(body.site, body.visitorId, e.selector, variantId, variantId, rawKey) : null;
        if (keyed) insertEvent.run(body.site, body.visitorId, variantId, e.selector, e.type, Date.now(), rawKey);
        else if (hasImp.get(body.site, body.visitorId, e.selector, variantId, variantId)) {
          insertEvent.run(body.site, body.visitorId, variantId, e.selector, e.type, Date.now(), null);
        } else return;
        recorded++;
        return;
      }
      insertEvent.run(body.site, body.visitorId, variantId, e.selector, e.type, Date.now(), rawKey);
      recorded++;
    });
  });
  tx();
  return c.json({
    ok: rejected.length === 0,
    recorded,
    ...(duplicates ? { duplicates } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(rejected.length ? { error: "invalid order", rejected } : {}),
  }, rejected.length ? 400 : 200);
});

app.get("/api/sites", async (c) => {
  const rows = db.prepare("SELECT DISTINCT site FROM variants UNION SELECT DISTINCT site FROM events UNION SELECT DISTINCT site FROM visitors").all() as { site: string }[];
  const sites = rows.map((r) => r.site);
  // Full admin, readonly seat, or viewer session: every site on this deployment.
  // Demo token: the demo site only. Anyone else: 401.
  if (await authorized(c, false, true)) return c.json(sites);
  if (demoTokenMatches(c)) return c.json(sites.filter((s) => s === "demo"));
  return c.json({ error: "unauthorized" }, 401);
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
  const reg = registerSite(b.site);
  if (!reg.ok) return c.json({ error: "site_cap", cap: reg.cap }, 402);
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

// Plan management: admin token only (no demo, no readonly).
const upsertPlan = db.prepare(
  "INSERT INTO sites (site, plan, created_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET plan = excluded.plan"
);
app.post("/api/sites/:site/plan", async (c) => {
  if (!(await fullAdmin(c))) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ plan?: string }>().catch(() => null);
  if (!body?.plan || !Object.hasOwn(PLANS, body.plan)) return c.json({ error: "unknown plan" }, 400);
  upsertPlan.run(c.req.param("site"), body.plan, Date.now());
  return c.json({ ok: true, site: c.req.param("site"), plan: body.plan });
});

// ---------- stats ----------
function statsBody(site: string) {
  const holdout = holdoutFor(site, defaultHoldoutPct());
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

  const exposedVisitors = db.prepare(
    "SELECT DISTINCT visitor_id FROM events WHERE site = ? AND type = 'impression' AND variant_id IS ?"
  );
  const creditedOrders = db.prepare(
    `SELECT o.visitor_id, o.currency, o.value_minor
     FROM orders o JOIN order_credits c ON c.site = o.site AND c.order_id = o.order_id
     WHERE o.site = ? AND c.arm = ?`
  );
  const armOrders = (variantId: number | null) => {
    const visitors = exposedVisitors.all(site, variantId) as { visitor_id: string }[];
    const orders = creditedOrders.all(site, variantId === null ? "control" : String(variantId)) as { visitor_id: string; currency: string; value_minor: number }[];
    return reportArm(
      visitors.map((v) => v.visitor_id),
      orders.map((o) => ({ visitorId: o.visitor_id, currency: o.currency, valueMinor: o.value_minor })),
    );
  };

  const withCI = rows.map((r) => ({
    ...r,
    rate: r.impressions ? r.conversions / r.impressions : null,
    ci95: wilson(r.conversions, r.impressions),
    ...armOrders(r.id),
  }));

  // Segments: trait field -> String(value) -> visitor count (top 50 fields).
  const segments: Record<string, Record<string, number>> = {};
  const traitRows = db.prepare("SELECT traits FROM visitors WHERE site = ?").all(site) as { traits: string }[];
  for (const r of traitRows) {
    let t: unknown;
    try { t = JSON.parse(r.traits); } catch { continue; }
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    for (const [k, v] of Object.entries(t)) {
      if (!Object.hasOwn(segments, k)) {
        if (Object.keys(segments).length >= 50) continue;
        segments[k] = {};
      }
      const bucket = segments[k]!;
      const key = String(v);
      bucket[key] = (bucket[key] ?? 0) + 1;
    }
  }

  const { plan } = sitePlan(site);
  return {
    variants: withCI,
    control: {
      ...control,
      rate: control.impressions ? control.conversions / control.impressions : null,
      ci95: wilson(control.conversions, control.impressions),
      ...armOrders(null),
    },
    holdoutPct: holdout.pct,
    holdoutPctSource: holdout.source,
    experiences: buildExperiences(site, holdout.pct),
    plan,
    usage: usageFor(site),
    segments,
  };
}

app.get("/api/stats", async (c) => {
  const site = c.req.query("site") ?? "demo";
  if (!(await authorizedForSite(c, site))) return c.json({ error: "unauthorized" }, 401);
  return c.json(statsBody(site));
});

function credentialPresent(c: AuthReq): boolean {
  return Boolean(requestToken(c)) || Boolean(getCookie(c as never)[SESSION_COOKIE]);
}

// Lift report and the per-site holdout are operator settings: admin token or an
// owner session. A demo token, editor, or viewer is signed in and still refused.
async function ownerOrAdmin(c: AuthReq): Promise<true | 401 | 403> {
  if (await fullAdmin(c)) return true;
  const email = await sessionEmail(getCookie(c as never)[SESSION_COOKIE]);
  if (email && accountRole(email)) return 403;
  const tok = requestToken(c);
  if (tok && (tok === DEMO_TOKEN || Object.hasOwn(READONLY_TOKENS, tok))) return 403;
  if (credentialPresent(c)) return 401;
  return 401;
}

app.post("/api/sites/:site/holdout", async (c) => {
  const gate = await ownerOrAdmin(c);
  if (gate !== true) return c.json({ error: gate === 403 ? "forbidden" : "unauthorized" }, gate);
  const site = c.req.param("site");
  if (!SITE_RE.test(site)) return c.json({ error: "invalid site" }, 400);
  const body = await c.req.json<{ holdoutPct?: unknown }>().catch(() => null);
  if (!body || !("holdoutPct" in body)) return c.json({ error: "holdoutPct required" }, 400);
  const raw = body.holdoutPct;
  if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100)) {
    return c.json({ error: "holdoutPct must be an integer from 0 to 100, or null" }, 400);
  }
  const saved = saveHoldout(site, raw);
  if (!saved.ok) return c.json({ error: "site_cap", cap: saved.cap }, 402);
  const holdout = holdoutFor(site, defaultHoldoutPct());
  return c.json({ ok: true, site, holdoutPct: holdout.pct, holdoutPctSource: holdout.source });
});

app.get("/api/sites/:site/lift-report", async (c) => {
  const gate = await ownerOrAdmin(c);
  if (gate !== true) return c.json({ error: gate === 403 ? "forbidden" : "unauthorized" }, gate);
  const site = c.req.param("site");
  if (!SITE_RE.test(site)) return c.json({ error: "invalid site" }, 400);
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "html" && format !== "csv") return c.json({ error: "invalid format" }, 400);
  const stats = statsBody(site);
  const report: LiftReport = {
    site,
    generatedAt: new Date().toISOString(),
    holdoutPct: stats.holdoutPct,
    holdoutPctSource: stats.holdoutPctSource,
    note: REPORT_NOTE,
    experiences: stats.experiences,
    pooled: {
      variants: stats.variants.map((v) => ({
        id: v.id,
        name: v.name,
        selector: v.selector,
        impressions: v.impressions,
        conversions: v.conversions,
        orders: v.orders,
      })),
      control: {
        impressions: stats.control.impressions,
        conversions: stats.control.conversions,
        orders: stats.control.orders,
      },
    },
  };
  c.header("cache-control", "no-store");
  if (format === "html") return c.html(renderLiftHtml(report));
  if (format === "csv") {
    c.header("content-disposition", `attachment; filename="prism-lift-${site}.csv"`);
    return c.text(renderLiftCsv(report), 200, { "content-type": "text/csv; charset=utf-8" });
  }
  return c.json(report);
});

// ---------- export / DSR ----------
app.get("/api/export", async (c) => {
  const site = c.req.query("site") ?? "demo";
  if (!(await authorizedForSite(c, site))) return c.json({ error: "unauthorized" }, 401);
  return c.json({
    site,
    exportedAt: new Date().toISOString(),
    variants: db.prepare("SELECT * FROM variants WHERE site = ?").all(site),
    events: db.prepare("SELECT * FROM events WHERE site = ? ORDER BY ts").all(site),
    visitors: db.prepare("SELECT * FROM visitors WHERE site = ?").all(site),
    orders: db.prepare("SELECT * FROM orders WHERE site = ? ORDER BY ts").all(site),
  });
});

// GDPR/CCPA: export or erase one visitor across visitors+events. Token-gated —
// these read/destroy PII-adjacent data, so they use the same auth as /admin.
app.use("/api/visitors/*", async (c, next) => {
  // Readonly tokens may read a visitor but never erase one. Demo token: demo site only.
  const site = c.req.query("site") ?? "demo";
  const write = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (!(await authorizedForSite(c, site, { write }))) return c.json({ error: "unauthorized" }, 401);
  return next();
});
app.get("/api/visitors/:id", (c) => {
  const site = c.req.query("site") ?? "demo";
  return c.json({
    visitor: getVisitor.get(c.req.param("id"), site) ?? null,
    events: db.prepare("SELECT * FROM events WHERE visitor_id = ? AND site = ?").all(c.req.param("id"), site),
    orders: db.prepare("SELECT * FROM orders WHERE visitor_id = ? AND site = ?").all(c.req.param("id"), site),
  });
});
app.delete("/api/visitors/:id", (c) => {
  const site = c.req.query("site") ?? "demo";
  const id = c.req.param("id");
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM order_credits WHERE site = ? AND order_id IN (SELECT order_id FROM orders WHERE site = ? AND visitor_id = ?)").run(site, site, id);
    db.prepare("DELETE FROM orders WHERE visitor_id = ? AND site = ?").run(id, site);
    db.prepare("DELETE FROM events WHERE visitor_id = ? AND site = ?").run(id, site);
    db.prepare("DELETE FROM visitors WHERE id = ? AND site = ?").run(id, site);
  });
  tx(); // the erasure must actually run
  return c.json({ ok: true, deleted: id });
});

// ---------- auth (Google OAuth for humans; Bearer tokens unchanged for agents) ----------
// Auth cookies are Secure everywhere except plain-http loopback (local dev and the
// e2e server), where browsers would drop a Secure cookie set over http.
function secureCookies(c: { req: { url: string; header: (n: string) => string | undefined } }) {
  if (c.req.header("x-forwarded-proto") === "https") return true;
  const u = new URL(c.req.url);
  return u.protocol === "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}
const cookieOpts = (c: Parameters<typeof secureCookies>[0], maxAge: number) =>
  ({ httpOnly: true, secure: secureCookies(c), sameSite: "Lax", maxAge, path: "/" }) as const;
const redirectUri = (url: string) => (process.env.BASE_URL ?? new URL(url).origin) + "/auth/callback";

app.get("/auth/login", (c) => c.html(loginPage(c.req.query("error"))));

app.get("/auth/google", (c) => {
  if (!oauthEnabled) return c.redirect("/auth/login");
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  setCookie(c, "prism_oauth_state", state + ":" + nonce, cookieOpts(c, 600));
  return c.redirect(googleAuthUrl(redirectUri(c.req.url), state, nonce));
});

app.get("/auth/callback", async (c) => {
  if (!oauthEnabled) return c.redirect("/auth/login");
  const [state, nonce] = (getCookie(c)["prism_oauth_state"] ?? "").split(":");
  deleteCookie(c, "prism_oauth_state", { path: "/", secure: secureCookies(c) });
  if (!state || !nonce || c.req.query("state") !== state) return c.html(loginPage("Sign-in state mismatch — try again."), 400);
  const code = c.req.query("code");
  if (!code) return c.html(loginPage("Google did not return an authorization code."), 400);
  const idToken = await exchangeCode(code, redirectUri(c.req.url));
  if (!idToken) return c.html(loginPage("Token exchange with Google failed."), 502);
  const id = await verifyGoogleIdToken(idToken, process.env.GOOGLE_CLIENT_ID!, nonce);
  if (!id) return c.html(loginPage("Could not verify your Google identity."), 401);
  if (!accountRole(id.email)) return c.html(loginPage(`${id.email} is not on the allowlist for this deployment.`), 403);
  setCookie(c, SESSION_COOKIE, await makeSession(id.email), cookieOpts(c, 7 * 86400));
  return c.redirect("/admin");
});

// Local development bypass — only exists when DEV_AUTH_EMAIL is set (never set it in prod).
app.get("/auth/dev-login", async (c) => {
  if (!DEV_EMAIL) return c.text("Not found", 404);
  setCookie(c, SESSION_COOKIE, await makeSession(DEV_EMAIL), cookieOpts(c, 7 * 86400));
  return c.redirect("/admin");
});

app.get("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookies(c) });
  return c.redirect("/auth/login");
});

const PILOT_INQUIRY_LIMIT = Number(process.env.PILOT_INQUIRY_LIMIT ?? 8);
const pilotInquiryRate = windowCounter(PILOT_INQUIRY_LIMIT, 3_600_000);
const insInquiry = db.prepare(
  "INSERT INTO pilot_inquiries (email, store_url, monthly_visitors, note, created_at) VALUES (?, ?, ?, ?, ?)"
);
const listInquiries = db.prepare(
  "SELECT id, email, store_url, monthly_visitors, note, created_at FROM pilot_inquiries ORDER BY id DESC"
);

async function ownerSession(c: AuthReq): Promise<boolean> {
  const email = await sessionEmail(getCookie(c as never)[SESSION_COOKIE]);
  return Boolean(email && accountRole(email) === "owner");
}

async function payView(c: AuthReq): Promise<PayView> {
  const decision = billingDecision(process.env);
  const showPay = decision.payAudience === "everyone" || (decision.payAudience === "operator" && await ownerSession(c));
  return { showPay, paymentLink: showPay ? decision.paymentLink : null };
}

app.get("/pilot", async (c) => c.html(pilotPage("form", await payView(c))));

app.get("/pilot/thanks", (c) => c.html(pilotPage("paid")));

app.get("/api/pilot/billing-status", async (c) => {
  if (!(await fullAdmin(c))) return c.json({ error: "unauthorized" }, 401);
  const decision = billingDecision(process.env);
  const priceShown = decision.payAudience === "everyone" || (decision.payAudience === "operator" && await ownerSession(c));
  return c.json({ mode: decision.mode, effectiveMode: decision.effectiveMode, priceShown });
});

app.post("/api/pilot/inquiry", async (c) => {
  const type = c.req.header("content-type") ?? "";
  const wantsHtml = type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
  let raw: unknown = null;
  try {
    if (type.includes("application/json")) raw = await c.req.json();
    else if (wantsHtml) raw = await c.req.parseBody();
  } catch {
    raw = null;
  }
  const pay = await payView(c);
  if (!pilotInquiryRate.hit(clientIp((name) => c.req.header(name)) + "|pilot")) {
    return wantsHtml ? c.html(pilotPage("error", pay), 429) : c.json({ error: "rate_limited" }, 429);
  }
  const parsed = parsePilotInquiry(raw);
  if (!parsed.ok) return wantsHtml ? c.html(pilotPage("error", pay), 400) : c.json({ error: "invalid" }, 400);
  const inquiry = parsed.inquiry;
  insInquiry.run(inquiry.email, inquiry.storeUrl, inquiry.monthlyVisitors, inquiry.note, Date.now());
  return wantsHtml ? c.html(pilotPage("thanks", pay), 200) : c.json({ ok: true });
});

app.get("/api/pilot/inquiries", async (c) => {
  if (!(await fullAdmin(c))) return c.json({ error: "unauthorized" }, 401);
  const rows = listInquiries.all() as {
    id: number; email: string; store_url: string; monthly_visitors: string | null; note: string | null; created_at: number;
  }[];
  return c.json({
    inquiries: rows.map((row) => ({
      id: row.id,
      email: row.email,
      storeUrl: row.store_url,
      monthlyVisitors: row.monthly_visitors,
      note: row.note,
      createdAt: row.created_at,
    })),
  });
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
<p>For each visitor: a random ID in a first-party cookie (<code>prism_vid</code>, SameSite=Lax, 400 days), visit counts, and any traits the site explicitly sends through <code>prism.identify()</code>. For each event: the variant shown, the selector, whether it was an impression or conversion, and a timestamp. For each order: the order id, the amount in minor units, the currency, and a timestamp.</p>
<h2>What we never do</h2>
<p>We don't fingerprint browsers, set third-party cookies, or track visitors across sites. Visitor data is never sold or shared. Events stay in the site's own first-party context.</p>
<h2>Your rights (GDPR / CCPA)</h2>
<p>Export one visitor: <code>GET /api/visitors/:id?site=…</code>. Erase one visitor: <code>DELETE /api/visitors/:id?site=…</code>, which removes their profile, every event, and every order. Both endpoints require the same Bearer token as the dashboard. Full site export: <code>GET /api/export?site=…</code> (also token-gated).</p>
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
<p>Variant writes, the dashboard, exports, privacy endpoints, and catalog reads (<code>/api/sites</code>, <code>/api/variants</code>, <code>/api/stats</code>) require a Bearer token or a signed-in session. The demo token reaches only the <code>demo</code> site. An optional per-site write key (<code>SITE_WRITE_KEY</code>) locks identify and event ingestion against poisoning. For supply-chain control, self-host the snippet from your own domain (<code>data-host</code>) or pin the versioned immutable URL <code>/snippet.v1.js</code>.</p>
<h2>Data integrity</h2>
<p>Conversions are only recorded for visitors with a matching prior impression. Stats ship with 95% intervals. Each audience has its own holdout. The default is 10% of visitors, and a site can set its own percentage. Wide intervals are reported as not enough data yet.</p>
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
// Internal architecture docs — same access rules as /admin (admin, demo, readonly).
app.get("/architecture", async (c) => {
  if (!(await authorized(c, true, true)))
    return oauthEnabled ? c.redirect("/auth/login") : c.text("Unauthorized. Pass ?token= or an Authorization: Bearer header.", 401);
  return c.html(architecture());
});
// Snippet: long cache + immutable-ish; it only changes on deploy, and cache-bust via ?v= if needed.
app.use("/snippet.js", async (c, next) => {
  await next();
  c.header("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
});
app.use("/snippet.js", serveStatic({ path: "./public/snippet.js" }));
let landingTemplate: string | undefined;

async function landingDocument(pay: PayView): Promise<string> {
  if (landingTemplate === undefined) landingTemplate = await Bun.file("landing/index.html").text();
  return applyOffers(landingTemplate, pay);
}

app.use("/landing/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/landing/" || path === "/landing/index.html") return c.html(await landingDocument(await payView(c)));
  await next();
});
app.use("/landing/*", serveStatic({ root: "./landing", rewriteRequestPath: (p) => p.replace(/^\/landing/, "") || "/index.html" }));
app.get("/landing", (c) => c.redirect("/"));
app.use("/demo/*", serveStatic({ root: "./demo", rewriteRequestPath: (p) => p.replace(/^\/demo/, "") || "/index.html" }));
app.get("/demo", (c) => c.redirect("/demo/"));
app.get("/", async (c) => c.html(await landingDocument(await payView(c))));

export default app;
