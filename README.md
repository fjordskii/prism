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
| `ADMIN_TOKEN` | unset (open) | Bearer token for variant writes, /admin, exports, and catalog reads |
| `DEMO_TOKEN` | historical demo token, if unset | demo token (ask operator). Reaches only site `demo`. Rotation is a Fly secret (`fly secrets set DEMO_TOKEN=...`) |
| `SITE_WRITE_KEY` | unset (open) | if set, snippet must send `data-key` to post traits/events |
| `HOLDOUT_PCT` | `10` | % of eligible visitors held out as control per selector |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset (OAuth off) | Google OAuth client; enables `/auth/login` for browser access |
| `GOOGLE_ALLOWED_EMAILS` | unset | comma list, `email` or `email:owner|viewer` (default `editor`); seeds the `accounts` table |
| `SESSION_SECRET` | `ADMIN_TOKEN` | signs session cookies; rotate to revoke all sessions |
| `BASE_URL` | request origin | external origin for the OAuth redirect URI (set behind a proxy) |
| `DEV_AUTH_EMAIL` | unset | local dev only: `/auth/dev-login` signs in as this email, no Google round-trip. NEVER set in production |
| `PRISM_PLAN` | `selfhost` | plan assigned to newly-registered sites (`selfhost` = unlimited) |
| `READONLY_TOKENS` | unset | comma-separated tokens with read-only access (GET routes, /admin, /api/export); mutations rejected |

## Auth model

- **Humans** (dashboard, architecture page, exports): Google sign-in when
  `GOOGLE_CLIENT_ID`/`SECRET` are set — `/auth/login` → session cookie. Roles come
  from the `accounts` table: `owner` (everything incl. plan changes), `editor`
  (variant CRUD, exports), `viewer` (read-only — the Agency tier's "read-only seat").
- **Agents and scripts**: unchanged — `Authorization: Bearer $ADMIN_TOKEN`,
  `READONLY_TOKENS`, `DEMO_TOKEN`, and `?token=` all keep working. The demo
  token is scoped to site `demo` on every token-gated route (export, visitor
  export/erasure, variant writes, and `GET /api/sites`, `/api/variants`, `/api/stats`).
- Unset everything auth-related and the deployment is open (local-dev default).

Seed the demo storefront data: `bun run src/seed.ts && bun run src/seed-stats.ts`

## End-to-end tests

CI: the `e2e` workflow runs unit + e2e on every PR and push to main.

```sh
bun install
bun run test:e2e            # gating suite: landing, demo personas, admin, API, regressions (desktop + 390px mobile)
bun run test:e2e:bugbash    # open bug repros; expected to fail until fixed
```

The `e2e` CLI needs Node.js 22.22.3+ or 24.8+ on `PATH` (`module.registerHooks`). `bun run` launches that CLI; the app process is still Bun.

The runner (Playwright Chromium) starts `tests/support/serve.ts` on a free port with a fresh seeded
SQLite DB and throwaway tokens. Admin tests sign in with that admin token (`?token=` and `Authorization: Bearer`).
`DEV_AUTH_EMAIL` is set on the test server so a session-cookie check can hit `/auth/dev-login`. The gating suite
is deterministic. `e2e.config.ts` still names a GitHub Copilot model for any future `agent.*` step
(`npx e2e login github-copilot`); the returning-customer check clicks the persona itself.
Latest report: `docs/e2e-report.md`.

## Install the snippet on your site

```html
<script defer src="https://YOUR_HOST/snippet.js" data-site="yourstore"></script>
```

```js
prism.identify({ orders: 3, intent: "gift" });  // enrich the visitor profile
prism.convert("#hero");                          // manual conversion
```

Elements with `data-prism-convert="#selector"` auto-track conversions on click.

## Authoring variants

The dashboard's variant builder defaults to a visual block editor — add
Eyebrow/Heading/Text/Button/Banner/Image blocks from the palette, drag to
reorder (or use ↑↓), and watch the live preview; no HTML required. The
**HTML** toggle is the escape hatch: markup the block editor can't round-trip
(nested divs, lists, scripts) opens there untouched instead of being mangled.
Button blocks carry an optional conversion-selector field that emits
`data-prism-convert` for auto-tracked clicks.

## API

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/identify` | POST | write key | upsert visitor traits |
| `/api/decide` | POST | — | audience match → bandit pick per selector |
| `/api/events` | POST | write key | impressions/conversions (sendBeacon-safe) |
| `/api/variants` | GET/POST | token or session for that site; POST writes need admin, editor, or the demo token on `demo` | list / create variants |
| `/api/variants/:id/toggle` · `DELETE /api/variants/:id` | | token; demo token only for `demo` variants | pause / remove |
| `/api/stats?site=` | GET | token or session for that site | per-variant rates, 95% Wilson CIs, holdout control |
| `/api/sites` | GET | token or session; demo token lists `demo` only | site slugs the caller may see |
| `/api/export?site=` | GET | token or session for that site | full tenant dump (variants, events, visitors) |
| `/api/visitors/:id?site=` | GET/DELETE | token or session for that site; demo token only for `demo`; readonly tokens cannot delete | GDPR/CCPA export & erasure |
| `/api/sites/:site/plan` | POST | admin token or owner session | set a site's plan (`{plan: "growth"}`) |

## Plans and limits

Hosted plans are enforced server-side; the plan registry lives in `src/plans.ts`.
Newly-registered sites get the plan named by `PRISM_PLAN` (default `selfhost`).

| Plan | Visitors/mo | Sites | Personalization |
|---|---|---|---|
| `shadow` | 10,000 | 1 | no — tracking only |
| `growth` | 100,000 | 3 | yes |
| `pro` | 500,000 | 5 | yes |
| `agency` | 1,000,000 | unlimited | yes |
| `selfhost` | unlimited | unlimited | yes |

`selfhost` is the default precisely because self-hosting is never capped.

Overage and shadow both fail soft — tracking continues, nothing auto-bills:
when a site is over its visitor cap or on `shadow`, `POST /api/decide` still
returns 200, but with `decisions: []` and `shadow: true` (plus the site's
`plan` and `usage`). `GET /api/stats?site=` exposes `plan`,
`usage: { visitors, visitorCap, overLimit }`, and `segments` (trait field →
value → visitor count). Registering a never-seen site via `POST /api/variants`
returns `402 { error: "site_cap", cap }` once the deployment's site cap is full.

Change a site's plan with `POST /api/sites/:site/plan` body
`{"plan": "growth"}` (admin token; 400 on unknown plan). Issue read-only seats
via the `READONLY_TOKENS` env var: those tokens reach GET routes, `/admin`,
`/api/export`, and `GET /api/visitors/:id`, but every mutation is rejected.

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
