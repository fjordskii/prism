// Prism server: decision API, event ingest, admin dashboard, static demo + snippet.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/bun";
import { db, matchAudience, type Variant, type Rule } from "./db";
import { parseOrder, reportArm } from "./money";
import { banditScore } from "./bandit";
import { pooledTotals } from "./counts";
import { dashboard } from "./dashboard";
import { architecture } from "./architecture";
import { PLANS, sitePlan, usageFor, holdoutFor, saveHoldout, applyCap } from "./plans";
import { audienceKey, defaultHoldoutPct, isHoldout, pickExperience } from "./holdout";
import { wilson, REPORT_NOTE } from "./lift";
import { buildExperiences, renderLiftCsv, renderLiftHtml, type LiftReport } from "./experiences";
import {
  oauthEnabled, DEV_EMAIL, SESSION_COOKIE, loginPage,
  accountRole, makeSession, googleAuthUrl, exchangeCode, verifyGoogleIdToken,
} from "./auth";
import {
  SITE_RE, deleteMembership, listVisibleSites, openAdmin, requireAdminToken, requireDeployment,
  requireSite, upsertMembership, wideOwnerSession, type AccessCtx,
} from "./access";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { windowCounter, clientIp } from "./ratelimit";
import { applyOffers, billingDecision, parsePilotInquiry, pilotPage, type PayView } from "./offer";
import {
  GROWTH_BODY_MAX, attributionFrom, growthClientScript, growthRange, growthReport, parseGrowthBody,
  utcDay, type Attribution, type GrowthCountRow, type GrowthEvent,
} from "./growth";

// Real SRI hash of the snippet, printed so operators can pin it in CSP/integrity.
const snippetSri = new Bun.CryptoHasher("sha384").update(await Bun.file("public/snippet.js").arrayBuffer()).digest("base64");
console.log("snippet.v1.js SRI: sha384-" + snippetSri);

const app = new Hono();
app.use("/api/*", cors());
// Malformed JSON bodies are a client error, not a 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
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
// Metering: decide counts visitors even before first identify, so usage is honest.
// Only a site that already has a row or a variant is metered, so a made-up name writes nothing.
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
const growthLimitRaw = Number(process.env.GROWTH_RATE_PER_MIN ?? process.env.DECIDE_RATE_PER_MIN ?? 600);
const GROWTH_PER_MIN = Number.isFinite(growthLimitRaw) && growthLimitRaw >= 1 ? growthLimitRaw : 600;
const growthRate = windowCounter(GROWTH_PER_MIN, 60_000);
const newVisitorRate = windowCounter(NEW_VISITORS_PER_HOUR, 3_600_000);

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
  const canRead = (await requireSite(c, body.site, "viewer")).ok;

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
  const listed = await listVisibleSites(c);
  if (!listed.ok) return c.json({ error: listed.error }, listed.status);
  return c.json(listed.sites);
});
// ---------- admin CRUD ----------
app.get("/api/variants", async (c) => {
  const site = c.req.query("site") ?? "demo";
  const gate = await requireSite(c, site, "viewer");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  return c.json(db.prepare("SELECT * FROM variants WHERE site = ? ORDER BY id").all(site));
});

app.post("/api/variants", async (c) => {
  const b = await c.req.json().catch(() => ({})) as Partial<Variant> & { site?: string; name?: string; selector?: string };
  if (!b.site || !b.name || !b.selector) return c.json({ error: "site, name, selector required" }, 400);
  const gate = await requireSite(c, b.site, "editor");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const cap = applyCap(gate.canRegisterSite, b.site);
  if (!cap.ok) {
    return cap.error === "forbidden"
      ? c.json({ error: "forbidden" }, 403)
      : c.json({ error: "site_cap", cap: cap.cap }, 402);
  }
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

app.post("/api/variants/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const row = db.prepare("SELECT site FROM variants WHERE id = ?").get(id) as { site: string } | undefined;
  const gate = await requireSite(c, row?.site ?? "", "editor", "missing");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  db.prepare("UPDATE variants SET active = 1 - active WHERE id = ?").run(id);
  return c.json({ ok: true });
});

app.delete("/api/variants/:id", async (c) => {
  const id = c.req.param("id");
  const row = db.prepare("SELECT site FROM variants WHERE id = ?").get(id) as { site: string } | undefined;
  const gate = await requireSite(c, row?.site ?? "", "editor", "missing");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  db.prepare("DELETE FROM variants WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// Plan changes stay deployment-wide. A site-scoped owner cannot set one.
const upsertPlan = db.prepare(
  "INSERT INTO sites (site, plan, created_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET plan = excluded.plan"
);
app.post("/api/sites/:site/plan", async (c) => {
  const gate = await requireDeployment(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const body = await c.req.json<{ plan?: string }>().catch(() => null);
  if (!body?.plan || !Object.hasOwn(PLANS, body.plan)) return c.json({ error: "unknown plan" }, 400);
  upsertPlan.run(c.req.param("site"), body.plan, Date.now());
  return c.json({ ok: true, site: c.req.param("site"), plan: body.plan });
});

app.put("/api/account-sites", async (c) => {
  const gate = await requireAdminToken(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const result = upsertMembership(await c.req.json().catch(() => null));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.delete("/api/account-sites", async (c) => {
  const gate = await requireAdminToken(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const result = deleteMembership(await c.req.json().catch(() => null));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

// ---------- stats ----------
function statsBody(site: string) {
  const holdout = holdoutFor(site, defaultHoldoutPct());
  const pooled = pooledTotals(db, site);
  const variantRows = db
    .prepare(
      `SELECT id, name, selector, active, starts_at, ends_at
       FROM variants WHERE site = ? ORDER BY id`
    )
    .all(site) as { id: number; name: string; selector: string; active: number; starts_at: number | null; ends_at: number | null }[];
  const rows = variantRows.map((row) => {
    const totals = pooled.variants.get(row.id) ?? { impressions: 0, conversions: 0 };
    return { ...row, impressions: totals.impressions, conversions: totals.conversions };
  });
  const control = pooled.control;

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
  const gate = await requireSite(c, site, "viewer");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  return c.json(statsBody(site));
});

app.post("/api/sites/:site/holdout", async (c) => {
  const site = c.req.param("site");
  const gate = await requireSite(c, site, "owner");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  if (!SITE_RE.test(site)) return c.json({ error: "invalid site" }, 400);
  const body = await c.req.json<{ holdoutPct?: unknown }>().catch(() => null);
  if (!body || !("holdoutPct" in body)) return c.json({ error: "holdoutPct required" }, 400);
  const raw = body.holdoutPct;
  if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 100)) {
    return c.json({ error: "holdoutPct must be an integer from 0 to 100, or null" }, 400);
  }
  const cap = applyCap(gate.canRegisterSite, site);
  if (!cap.ok) {
    return cap.error === "forbidden"
      ? c.json({ error: "forbidden" }, 403)
      : c.json({ error: "site_cap", cap: cap.cap }, 402);
  }
  const saved = saveHoldout(site, raw);
  if (!saved.ok) return c.json({ error: "unregistered" }, 403);
  const holdout = holdoutFor(site, defaultHoldoutPct());
  return c.json({ ok: true, site, holdoutPct: holdout.pct, holdoutPctSource: holdout.source });
});

app.get("/api/sites/:site/lift-report", async (c) => {
  const site = c.req.param("site");
  const gate = await requireSite(c, site, "owner");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
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
  const gate = await requireSite(c, site, "viewer");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  return c.json({
    site,
    exportedAt: new Date().toISOString(),
    variants: db.prepare("SELECT * FROM variants WHERE site = ?").all(site),
    events: db.prepare("SELECT * FROM events WHERE site = ? ORDER BY ts").all(site),
    visitors: db.prepare("SELECT * FROM visitors WHERE site = ?").all(site),
    orders: db.prepare("SELECT * FROM orders WHERE site = ? ORDER BY ts").all(site),
  });
});

app.get("/api/visitors/:id", async (c) => {
  const site = c.req.query("site") ?? "demo";
  const gate = await requireSite(c, site, "viewer");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  return c.json({
    visitor: getVisitor.get(c.req.param("id"), site) ?? null,
    events: db.prepare("SELECT * FROM events WHERE visitor_id = ? AND site = ?").all(c.req.param("id"), site),
    orders: db.prepare("SELECT * FROM orders WHERE visitor_id = ? AND site = ?").all(c.req.param("id"), site),
  });
});
app.delete("/api/visitors/:id", async (c) => {
  const site = c.req.query("site") ?? "demo";
  // Editor, not owner: the demo token may erase site demo and still gets 401 off demo.
  const gate = await requireSite(c, site, "editor");
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
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
const insGrowth = db.prepare(
  `INSERT INTO growth_events (event, day, utm_source, utm_medium, utm_campaign, referrer_host, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const growthGrouped = db.prepare(
  `SELECT event, day,
          utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
          referrer_host AS referrerHost, COUNT(*) AS count
   FROM growth_events
   WHERE day >= ? AND day <= ?
   GROUP BY event, day, utm_source, utm_medium, utm_campaign, referrer_host`
);

function recordGrowth(event: GrowthEvent, attribution: Attribution, ts = Date.now()) {
  insGrowth.run(
    event,
    utcDay(ts),
    attribution.source,
    attribution.medium,
    attribution.campaign,
    attribution.referrerHost,
    ts,
  );
}

// Public count. The client IP is a rate-limit key in memory only; it is not written.
app.post("/api/growth", async (c) => {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > GROWTH_BODY_MAX) return c.json({ error: "too_large" }, 413);
  let text = "";
  try {
    text = await c.req.text();
  } catch {
    return c.json({ error: "invalid" }, 400);
  }
  if (text.length > GROWTH_BODY_MAX) return c.json({ error: "too_large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid" }, 400);
  }
  const event = parseGrowthBody(parsed, c.req.header("referer") ?? c.req.header("referrer"));
  if (!event.ok) return c.json({ error: "invalid" }, 400);
  const bucket = clientIp((name) => c.req.header(name)) + "|growth";
  if (!growthRate.hit(bucket)) return c.json({ error: "rate_limited" }, 429);
  recordGrowth(event.event, event.attribution);
  return new Response(null, { status: 204 });
});

app.get("/api/growth", async (c) => {
  const gate = await requireDeployment(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const range = growthRange(c.req.query("from"), c.req.query("to"));
  if (!range.ok) return c.json({ error: "invalid" }, 400);
  const rows = (growthGrouped.all(range.from, range.to) as Record<string, unknown>[]).map(mapGrowthRow);
  return c.json(growthReport(rows, range.from, range.to));
});

function mapGrowthRow(row: Record<string, unknown>): GrowthCountRow {
  return {
    event: String(row.event),
    day: String(row.day),
    source: String(row.source ?? ""),
    medium: String(row.medium ?? ""),
    campaign: String(row.campaign ?? ""),
    referrerHost: String(row.referrerHost ?? row.referrer_host ?? ""),
    count: Number(row.count),
  };
}

const listInquiries = db.prepare(
  "SELECT id, email, store_url, monthly_visitors, note, created_at FROM pilot_inquiries ORDER BY id DESC"
);

async function payView(c: AccessCtx): Promise<PayView> {
  const decision = billingDecision(process.env);
  const showPay = decision.payAudience === "everyone" || (decision.payAudience === "operator" && await wideOwnerSession(c));
  return { showPay, paymentLink: showPay ? decision.paymentLink : null };
}

app.get("/pilot", async (c) => c.html(pilotPage("form", await payView(c))));

app.get("/pilot/thanks", (c) => c.html(pilotPage("paid")));

app.get("/api/pilot/billing-status", async (c) => {
  const gate = await requireDeployment(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
  const decision = billingDecision(process.env);
  const priceShown = decision.payAudience === "everyone" || (decision.payAudience === "operator" && await wideOwnerSession(c));
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
  const attribution = attributionFrom(raw, c.req.header("referer") ?? c.req.header("referrer"));
  const now = Date.now();
  db.transaction(() => {
    insInquiry.run(inquiry.email, inquiry.storeUrl, inquiry.monthlyVisitors, inquiry.note, now);
    recordGrowth("pilot_inquiry", attribution, now);
  })();
  return wantsHtml ? c.html(pilotPage("thanks", pay), 200) : c.json({ ok: true });
});

app.get("/api/pilot/inquiries", async (c) => {
  const gate = await requireDeployment(c);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
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
<p>On the landing page and the pilot page, Prism counts page views, clicks on the pilot buttons, copies of the install snippet, and inquiry form sends. Each count stores the date, the event name, the utm_source, utm_medium, and utm_campaign from the link, and the host of the referring site when one is available. The saved count has no cookie and no IP address.</p>
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
<p>The 14 KB snippet (5 KB gzipped) loads with <code>defer</code>. It hides only the sections named in <code>data-selectors</code>, and only until a decision arrives or a short timeout passes. Every DOM operation is wrapped in try/catch. If Prism is unreachable, visitors see your default page. Nothing in the request path runs a model or third-party code. Insert-style variants are idempotent: re-applied operations replace, never duplicate.</p>
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
      `<h2>Service and Billing</h2>
<p>Prism is hosted software for client-side website personalization. Offers: Discovery (free for the first 5 stores), Pilot ($750 flat for 30 days, fully refunded if setup or the day-30 report isn't delivered, no lift guarantee), and Retain ($299/mo, month to month). Cancel anytime. You keep a full data export at <code>/api/export</code>.</p>
<h2>Availability</h2>
<p>We aim to keep Prism running at all times but don't offer an uptime guarantee or service credits during the pilot. The snippet fails open: if Prism is down, your visitors see your normal site, never an error.</p>
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
app.get("/admin", async (c) => {
  const page = await openAdmin(c, c.req.query("site"));
  if (page.kind === "login") return c.redirect("/auth/login");
  if (page.kind === "unauthorized") return c.text("Unauthorized. Pass ?token= or an Authorization: Bearer header.", 401);
  return c.html(dashboard(page.boot));
});
app.get("/architecture", async (c) => {
  const gate = await requireDeployment(c);
  if (!gate.ok && gate.status === 401 && oauthEnabled) return c.redirect("/auth/login");
  if (!gate.ok && gate.status === 401) return c.text("Unauthorized. Pass ?token= or an Authorization: Bearer header.", 401);
  if (!gate.ok) return c.json({ error: gate.error }, gate.status);
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
  const html = applyOffers(landingTemplate, pay);
  const script = growthClientScript({ view: "landing_view", trackClicks: true });
  return html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : html + script;
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
