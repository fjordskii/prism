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

- Snippet: 9 KB vanilla JS (3 KB gzipped), zero deps, runs after first paint. Decision cache in
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

## Round-3 changes (verify live, don't trust this list)

- Demo token is now write-capable on the demo site ONLY: POST /api/variants with
  `authorization: Bearer demo-panel-2026` and site:"demo" works; other sites 401.
  Toggle/delete allowed for demo-site variants. Complete the authoring loop yourself.
- Admin dashboard: Edit button on every variant (reopens builder pre-filled),
  audience rules humanized in the table ("cartItems ≥ 3" not raw JSON).
- Insert ops are idempotent: re-application after a framework re-render replaces
  the old copy (tagged data-prism-owned), never duplicates. Verified against a
  simulated React hydration clobber.
- DSR endpoints are now token-gated (same auth as /admin): GET/DELETE
  /api/visitors/:id?site=…&token=demo-panel-2026
- Supply chain: immutable versioned snippet at /snippet.v1.js (max-age=1y,
immutable) with published SRI hash sha384-g8aa4Fhxe/l9XqedTYl+17fbXzXZ5YoQFCE93vdQhe9CIXaPRoXBoBJEmRV1+rlB;
  or self-host the snippet from your own domain with data-host + data-cookie
  overrides (white-label: custom API origin + custom cookie name).
- Source-available: github.com/fjordskii/prism (BSL 1.1 → Apache 2.0 in 2030);
  self-host with `bun run src/server.ts` or the Dockerfile.
- /terms now has a real SLA: 99.9% monthly, 10x-downtime service credits, auto-applied.
- Klaviyo snippet uses real Liquid fields (customer.orders_count, computed
  lastOrderDays from customer.last_order.created_at) + a _learnq bridge that
  forwards Klaviyo profile/segment membership into prism.identify.
- Contact: hello@sundaymorning.software (working domain, Google MX). Entity:
  Sunday Morning Software (Prism Labs).

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
