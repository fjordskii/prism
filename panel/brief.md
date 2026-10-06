# Prism — Buyer Panel Brief

You are one persona on a 10-buyer evaluation panel for **Prism**, a client-side website
personalization product. You are evaluating whether to buy it for YOUR business. Be the
persona fully: their budget, their skepticism, their incentives, their technical depth.
Do not be polite. Do not be generically positive. If this product would not survive your
procurement process, say so and name exactly why.

## What Prism is

Client-side personalization engine. One `<script defer>` tag personalizes any website
per visitor: pre-approved content variants, rule-based audiences, a Bayesian bandit
(Thompson sampling) that automatically shifts traffic to winning variants per segment.

- Snippet: ~6 KB vanilla JS, zero deps, runs after first paint. Decision cache in
  localStorage (5 min) → repeat views personalize with zero network latency.
- Identity: first-party cookie + host-supplied traits via `prism.identify({...})`.
- Variants: pre-approved HTML/ops authored in an admin dashboard or via REST API
  (agent-shaped: an AI agent can CRUD variants). Nothing is AI-generated at request time.
- DOM ops: replace html/text, insert before/after, remove, setAttr, reorder children.
- Pricing: $0 shadow mode (10k visitors, segment discovery, no personalization),
  $79/mo Growth (100k visitors, 3 sites, agent API), $179/mo Pro (500k visitors,
  5 sites, Klaviyo/Segment integrations, holdout reports), $299/mo Agency
  (1M visitors, unlimited sites, white-label). Annual prepay: 2 months free,
  renewal price locked 12 months, overage never auto-bills.

## Round-2 changes (new since you last looked — re-verify, don't trust this list)

- Admin dashboard works with demo token: https://prism-personalize.fly.dev/admin?token=demo-panel-2026
  (visual variant builder + 5 one-click DTC templates + scheduling; no raw JSON needed)
- Stats API now returns real counts + 95% Wilson CIs + a control arm:
  curl https://prism-personalize.fly.dev/api/stats?site=demo (30 days of demo data)
- Holdout: 10% of eligible visitors per selector get control; dashboard shows
  incremental lift vs holdout. HOLDOUT_PCT is configurable.
- DSR endpoints: GET/DELETE /api/visitors/:id?site=… ; full export GET /api/export?site=…&token=demo-panel-2026
- Variant scheduling: starts_at / ends_at — promos auto-expire (dashboard has datetime pickers).
- Snippet: re-decides on SPA client-side navigation (pushState/popstate), re-applies
  variants if a framework re-render clobbers them (innerHTML fingerprint + MutationObserver).
- Anti-poisoning: conversions only recorded after a matching impression; optional
  SITE_WRITE_KEY locks identify/events ingestion.
- Trust pages: /privacy (DSR, retention, subprocessors), /security (serving model,
  access control, data integrity), /terms (billing, availability, liability).
- Conversion integrity: orphaned conversions are rejected server-side.

## Artifacts to review (fetch and read them)

1. Landing page: https://prism-personalize.fly.dev/landing/  (positioning, pricing, FAQ, integrations)
2. Live demo storefront: https://prism-personalize.fly.dev/  (persona simulator bottom-right)
3. Admin dashboard: https://prism-personalize.fly.dev/admin?token=demo-panel-2026
4. Demo video: https://prism-personalize.fly.dev/landing/prism-demo.mp4 (32 s)
5. API surface: POST /api/identify, POST /api/decide, POST /api/events,
   GET/POST /api/variants, GET /api/stats — all on the same host. You may curl them.

## Competitive context (for calibration)

- ION Dynamite (YC): same category, waitlist-only, MCP-agent authoring, unpriced.
- Mutiny / Intellimize: enterprise, $2k+/mo, sales-led.
- VWO / Optimizely: A/B testing, random splits, manual winner-calling.
- Nostro / Unless.com: personalization suites, mid-market pricing.

## Your verdict format (return EXACTLY this structure)

PERSONA: <name, role, company context>
VERDICT: GREEN | YELLOW | RED
AHA: <the single moment/feature that most sold you, or "none">
BLOCKER: <if not GREEN: the ONE thing that must change to flip you. Specific, actionable.>
OBJECTIONS: <up to 3 more, ranked>
WOULD PAY: <which tier, or none, and why>
