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
- Events: impressions + conversions beaconed back; per-variant conversion rates in admin.
- Infra: Bun + Hono + SQLite on Fly.io, auto-stop at idle, 1 GB snapshotted volume.
- Admin API mutating routes + dashboard gated by Bearer token.
- Pricing: $0 shadow mode (10k visitors, segment discovery, no personalization),
  $79/mo Growth (100k visitors, 3 sites, agent API), $299/mo Agency (1M, unlimited sites).

## Artifacts to review (fetch and read them)

1. Landing page: https://prism-personalize.fly.dev/landing/  (positioning, pricing, FAQ)
2. Live demo storefront: https://prism-personalize.fly.dev/  (persona simulator bottom-right;
   click a persona, watch the page change; personas persist via cookie)
3. Admin dashboard: https://prism-personalize.fly.dev/admin?token=REDACTED_DEMO
   (if the token fails, note it and evaluate from the API instead:
   curl https://prism-personalize.fly.dev/api/stats?site=demo)
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
