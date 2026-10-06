# Prism

Client-side website personalization engine — our shippable answer to ION Dynamite.
One `<script>` tag personalizes any site per visitor: pre-approved variants, rule-based
audiences, Thompson-sampling bandit for self-improving selection, cookie-first identity.

## Architecture

```
┌─ snippet.js (~6KB, vanilla, no deps) ─────────────┐
│ cookie identity → /api/decide → DOM ops post-paint │
│ impressions/conversions → sendBeacon → /api/events │
└──────────────────────┬─────────────────────────────┘
                       ▼
┌─ server.ts (Bun + Hono + SQLite) ─────────────────┐
│ /api/identify  upsert visitor traits               │
│ /api/decide    audience match → bandit pick        │
│ /api/events    impression/conversion ingest        │
│ /api/variants  CRUD · /api/stats · /admin          │
└────────────────────────────────────────────────────┘
```

**Design invariants**
- Variants are *pre-approved content*, never generated at request time (brand safety).
- Snippet runs post-paint and every op is try/caught — a bad variant can never break the host page.
- Decisions are cached in `localStorage` for 5 min → repeat pageviews personalize with zero network latency.
- Selection = Thompson sampling over Beta(conversions+1, impressions−conversions+1) per variant, restricted to audience-matching candidates. Exploration is automatic; winners emerge without manual A/B management.

## Run

```sh
bun install
bun run src/seed.ts        # seed 5 demo personas/variants
bun run src/server.ts      # http://localhost:3000
```

- Demo storefront: http://localhost:3000/ (persona simulator bottom-right)
- Admin: http://localhost:3000/admin (live stats, pause/delete, create variants)

## Install on any site

```html
<script defer src="https://YOUR_HOST/snippet.js" data-site="yoursite"></script>
```

Enrich the visitor profile from the host site:

```js
prism.identify({ orders: 2, lastOrderDays: 32, affinity: "woody" });
prism.convert("#hero"); // manual conversion
```

Elements with `data-prism-convert="#selector"` auto-track conversions on click.

## Variant model

```json
{
  "site": "demo",
  "name": "Gift-buyer hero",
  "selector": "#hero",
  "audience": [{"field": "intent", "op": "eq", "value": "gift"}],
  "ops": [{"op": "html", "html": "<h1>The gift that fills a room.</h1>"}]
}
```

Audience ops: `eq neq gt lt gte lte contains` (all rules must match).
DOM ops: `html | text | insertBefore | insertAfter | remove | setAttr | reorder`.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/identify` | POST | upsert visitor traits |
| `/api/decide` | POST | `{visitorId, site}` → matching variants, bandit-picked per selector |
| `/api/events` | POST | batched impressions/conversions (sendBeacon-safe) |
| `/api/variants` | GET/POST | list / create |
| `/api/variants/:id/toggle` | POST | pause/resume |
| `/api/variants/:id` | DELETE | remove |
| `/api/stats` | GET | per-variant impressions, conversions, rate |

## Deliberate MVP cuts (ship list for v2)

- MCP control plane (agent-authored variants) — CRUD API is already agent-shaped; wrap with an MCP server.
- Multi-armed cross-selector budgets, frequency caps, holdout group for true lift measurement.
- Geo/referrer/UTM trait auto-capture in snippet (currently host-supplied only).
- Auth on /admin + multi-tenant sites table.
- Edge deploy: server is stateless apart from SQLite → Turso/LiteFS, snippet behind CDN.
