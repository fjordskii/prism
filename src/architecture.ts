// Server-rendered architecture/diagrams page. Token-gated like /admin — internal docs.
export function architecture(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Architecture: Prism</title>
<style>
  body { font: 14px/1.6 -apple-system, system-ui, sans-serif; max-width: 1080px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 36px; }
  .lede { color: #555; }
  .mermaid { background: #fafaf8; border: 1px solid #e5e5e5; border-radius: 8px; padding: 20px; margin-top: 12px; overflow-x: auto; }
  .note { background: #fff8e6; border: 1px solid #f0e0b0; border-radius: 8px; padding: 12px 16px; margin-top: 12px; }
  code { background: #f0f0ec; padding: 1px 5px; border-radius: 4px; }
  ol li { margin: 6px 0; }
</style></head><body>
<h1>Prism: architecture</h1>
<p class="lede">How the system works from the visitor side and the owner side, and what an owner actually does to get live. Internal page — same token as <a href="/admin">/admin</a>.</p>

<h2>1. Visitor perspective: one pageview through the engine</h2>
<div class="mermaid">
sequenceDiagram
    autonumber
    participant V as Visitor browser
    participant S as Shop page (host site)
    participant SN as snippet.js (9 KB, deferred)
    participant LS as localStorage cache (5 min)
    participant API as Prism API (Hono)
    participant DB as SQLite
    participant PX as Shopify pixel
    V->>S: GET page
    S-->>V: HTML + script defer src=/snippet.js data-site=shop
    Note over SN: Runs AFTER first paint, never blocks render
    SN->>SN: Read/set first-party cookie (prism_vid, 400d)
    SN->>LS: readCache()
    alt cache under 5 min old
        LS-->>SN: cached decisions
        SN->>S: Apply DOM ops immediately (zero network latency)
    end
    SN->>API: POST /api/decide {visitorId, site}
    API->>DB: Insert-or-touch visitor row (metering)
    API->>DB: Load site plan (sites table)
    alt shadow plan or overLimit
        API-->>SN: decisions empty, shadow true (tracking only, fail soft)
    else personalizing plan
        API->>DB: Load active variants for site
        API->>API: matchAudience(rules, traits)
        API->>API: Deterministic holdout hash (10 pct control)
        API->>API: Thompson sample per candidate
        API-->>SN: decisions + plan + usage
    end
    SN->>LS: writeCache(decisions)
    SN->>S: applyOps (html/text/insert/remove/setAttr/reorder)
    Note over SN,S: Inserts tagged data-prism-owned (idempotent). MutationObserver re-applies after framework re-renders
    SN->>API: POST /api/events (impressions, batched)
    V->>S: Click data-prism-convert element
    SN->>API: POST /api/events (conversion)
    API->>DB: Recorded only with matching prior impression
    PX->>API: POST /api/events (order)
    API->>DB: One row per order id, credited to arms already seen
    V->>S: SPA navigation (pushState / popstate)
    SN->>SN: onNav, re-decide for new route
</div>

<h2>2. Owner perspective: surfaces, API, data, enforcement</h2>
<div class="mermaid">
flowchart TB
    subgraph Owner["Owner surfaces"]
        L["/ landing: pricing, install, integration recipes"]
        ADM["/admin: variants CRUD, stats + 95 pct CI, lift vs holdout, plan/usage meter, Segments"]
        AGENT["AI agent or scripts: same REST API"]
    end
    subgraph Edge["Prism service (Bun + Hono)"]
        AUTH["Auth: ADMIN_TOKEN full write; READONLY_TOKENS read-only seats; DEMO_TOKEN demo-site writes; SITE_WRITE_KEY ingest"]
        DECIDE["POST /api/decide: metering, plan gate, audience match, holdout, bandit"]
        EVENTS["POST /api/events: conversion and order require a prior impression"]
        CRUD["/api/variants CRUD + site-cap 402"]
        STATS["GET /api/stats: click rate, orders, RPV, AOV, control, plan, usage, segments"]
        DSR["/api/export and /api/visitors/:id: GDPR export/erasure"]
    end
    subgraph Data["SQLite (WAL, embedded)"]
        V[("visitors: id, site, traits, last_seen")]
        VA[("variants: site, selector, ops, audience, weight, schedule, active")]
        E[("events: visitor, variant?, type, ts")]
        O[("orders: order id, minor units, currency, credited arms")]
        SI[("sites: site, plan, created_at")]
    end
    subgraph Plans["Plan enforcement (src/plans.ts)"]
        P["shadow 10k/1 site/tracking-only; growth 100k/3; pro 500k/5; agency 1M/unlimited; selfhost unlimited"]
    end
    Owner --> ADM & AGENT
    ADM & AGENT --> AUTH
    AUTH --> CRUD & STATS & DSR
    VisitorSite["Visitor browsers (snippet.js)"] --> DECIDE & EVENTS
    DECIDE --> Plans
    DECIDE & EVENTS & CRUD & STATS & DSR --> Data
    STATS --> ADM
</div>

<h2>3. Owner onboarding, as the code stands today</h2>
<div class="note"><b>Honest gap:</b> there is no self-serve signup or checkout in the codebase. Step 2 is manual operator provisioning (or self-host). The metering/enforcement substrate a signup flow would sit on already exists.</div>
<div class="mermaid">
flowchart TD
    A["1. Owner lands on / : pricing, 32s demo"] --> B{"2. How do they get in?"}
    B -->|"Hosted (today)"| C["Operator provisions: site row registered, plan set via POST /api/sites/:site/plan, token issued"]
    B -->|"Self-host (BSL, free)"| D["git clone, bun install, bun run src/server.ts; PRISM_PLAN unset = selfhost = unlimited; set ADMIN_TOKEN"]
    C & D --> E["3. Paste one line: script defer src=.../snippet.js data-site=theirshop (optionally pinned /snippet.v1.js + integrity sha384)"]
    E --> F["4. Snippet starts metering visitors immediately, before any variant exists"]
    F --> G{"5. Does the plan personalize?"}
    G -->|"shadow plan"| H["decisions empty, shadow true; owner watches Segments + traffic in /admin = run in shadow for a week"]
    G -->|"growth and up"| I["6. Open /admin?token=..., pick a template or write a variant: selector + audience rule + HTML + optional schedule"]
    H -->|"upgrade via POST /api/sites/:site/plan"| I
    I --> J["7. Bandit + holdout run themselves; dashboard shows rate + 95 pct CI and incremental lift vs the 10 pct holdout"]
    J --> K{"8. Approaching visitor cap?"}
    K -->|"yes"| L["usage.overLimit: personalization pauses, tracking continues, red warning in dashboard; we contact you, nothing auto-bills"]
    K -->|"no"| J
    L -->|"plan bumped"| J
</div>

<h2>Open gaps in that journey</h2>
<ol>
  <li><b>No self-serve signup.</b> Provisioning is operator-run: plan via <code>POST /api/sites/:site/plan</code>, login via <code>GOOGLE_ALLOWED_EMAILS</code>. No checkout, no per-site account scoping.</li>
  <li><b>Accounts are per-deployment, not per-site.</b> Google OAuth logs humans in (<code>/auth/login</code>); the <code>accounts</code> table maps email to <code>owner | editor | viewer</code> (viewer = the Agency tier's read-only seat). But any logged-in user sees every site on the deployment — Agency's per-client scoping is not enforced.</li>
  <li><b>Agent API is not plan-gated.</b> Any valid token can CRUD variants on any plan, though the pricing page lists agent API as Growth+.</li>
  <li><b>Annual prepay, price lock, SLA credits</b> are policy text in <code>/terms</code>; no billing system automates them.</li>
</ol>

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: "neutral", flowchart: { htmlLabels: true } });
</script>
</body></html>`;
}
