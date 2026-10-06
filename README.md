# Prism — client-side personalization engine

One `<script>` tag personalizes any website per visitor: pre-approved variants,
rule-based audiences, a Bayesian bandit that shifts traffic to winners per segment.
No model in the request path.

**Hosted demo:** https://prism-personalize.fly.dev/ (storefront) ·
[/landing/](https://prism-personalize.fly.dev/landing/) (product page) ·
[/admin](https://prism-personalize.fly.dev/admin) (dashboard)

## Self-host (your own infra, ~5 minutes)

Requires [Bun](https://bun.sh). SQLite is embedded — no other services.

```sh
git clone https://github.com/fjordskii/prism && cd prism
bun install
bun run src/server.ts          # http://localhost:3000
```

Docker / Fly.io / any container host:

```sh
docker build -t prism .
docker run -p 3000:3000 -v prism-data:/data prism
```

Environment:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | listen port |
| `DB_PATH` | `prism.db` | SQLite file (use a volume in prod) |
| `ADMIN_TOKEN` | unset (open) | Bearer token for variant writes, /admin, /api/export |
| `SITE_WRITE_KEY` | unset (open) | if set, snippet must send `data-key` to post traits/events |
| `HOLDOUT_PCT` | `10` | % of eligible visitors held out as control per selector |

Seed the demo storefront data: `bun run src/seed.ts && bun run src/seed-stats.ts`

## Install the snippet on your site

```html
<script defer src="https://YOUR_HOST/snippet.js" data-site="yourstore"></script>
```

```js
prism.identify({ orders: 3, intent: "gift" });  // enrich the visitor profile
prism.convert("#hero");                          // manual conversion
```

Elements with `data-prism-convert="#selector"` auto-track conversions on click.

## API

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/identify` | POST | write key | upsert visitor traits |
| `/api/decide` | POST | — | audience match → bandit pick per selector |
| `/api/events` | POST | write key | impressions/conversions (sendBeacon-safe) |
| `/api/variants` | GET/POST | GET open, POST token | list / create variants |
| `/api/variants/:id/toggle` · `DELETE /api/variants/:id` | | token | pause / remove |
| `/api/stats?site=` | GET | — | per-variant rates, 95% Wilson CIs, holdout control |
| `/api/export?site=` | GET | token | full tenant dump (variants, events, visitors) |
| `/api/visitors/:id?site=` | GET/DELETE | — | GDPR/CCPA export & erasure |

## Design invariants

- Variants are pre-approved content, never generated at request time.
- Snippet runs post-paint; every DOM op is try/caught; API failure = default page (fail open).
- Repeat views personalize from a 5-min localStorage cache: zero network latency.
- SPA-aware: re-decides on pushState/popstate, re-applies after framework re-renders.
- Selection = Thompson sampling over Beta(conversions+1, impressions−conversions+1),
  with a deterministic holdout arm so incremental lift is always measurable.

## License

Business Source License 1.1 — free to self-host for your own sites; you may not
sell Prism as a competing hosted service. Converts to Apache 2.0 on 2030-10-06.
