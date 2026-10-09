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
| `BILLING_MODE` | `off` | `off`, `test`, or `live`. `off` shows no pay button |
| `PILOT_PAYMENT_LINK` | unset | Stripe Payment Link URL. Test mode accepts only a URL that starts with `https://buy.stripe.com/test_` |
| `BILLING_LIVE_APPROVED` | unset | set to `yes` before `BILLING_MODE=live` shows a pay button |

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

## Turn on pilot payment

The pay button stays off until you set the link, the mode, and, for a real charge, the approval flag. The app does not call Stripe. `PILOT_PAYMENT_LINK` is the Payment Link URL, and the button is that link. Prices and the offer sentences live in `src/offer.ts`.

1. In Stripe, create a Payment Link. Set its confirmation page to `https://prism-personalize.fly.dev/pilot/thanks`.
2. For a test charge, the link has to start with `https://buy.stripe.com/test_`. Set the link and the mode.

```sh
fly secrets set PILOT_PAYMENT_LINK="https://buy.stripe.com/test_..." BILLING_MODE=test
```

3. Sign in as an owner and open `/pilot`. The page shows "Pay for the pilot". Open `/pilot` in a private window. The button is absent, and the inquiry form is still there.
4. Check the mode with the admin token. `effectiveMode` is `test` when the link is a test link. It is `off` when the link is missing or is not a test link. `priceShown` is true only when the caller would see the pay button. In test mode, that caller is an owner session, so a token-only request reports `priceShown` false.

```sh
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://prism-personalize.fly.dev/api/pilot/billing-status
```

5. To charge a real card, create a live Payment Link on `https://buy.stripe.com/` whose URL does not start with `https://buy.stripe.com/test_`. Then set the approval flag and the mode. Until `BILLING_LIVE_APPROVED` is `yes`, live mode behaves as off.

```sh
fly secrets set PILOT_PAYMENT_LINK="https://buy.stripe.com/..." BILLING_LIVE_APPROVED=yes BILLING_MODE=live
```

6. Smoke test. `effectiveMode` in the status response is `live`, and a logged-out visit to `/pilot` shows "Pay for the pilot". After payment, Stripe sends the buyer to `/pilot/thanks`.

Seed the demo storefront data: `bun run src/seed.ts && bun run src/seed-stats.ts`

## End-to-end tests

CI: the `e2e` workflow runs unit + e2e on every PR and push to main. Production deploy runs only after that workflow succeeds on the same commit pushed to `main`; a pull request's e2e run never deploys, and a failed e2e on main does not deploy. Manual `workflow_dispatch` of the deploy workflow deploys the selected ref.

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

## Record Shopify orders

The snippet stores the visitor id in the `prism_vid` cookie. A Shopify custom pixel reads that cookie when checkout completes and posts an order to Prism.

1. In Shopify admin, open Settings, then Customer events.
2. Choose Add custom pixel. Name it Prism.
3. Paste `integrations/shopify/custom-pixel.js`.
4. Set `PRISM_HOST` to the Prism origin and `PRISM_SITE` to the same site slug as `data-site` on the snippet.
5. If the snippet uses `data-cookie`, set `PRISM_COOKIE` to that name. The default is `prism_vid`.
6. If the server has `SITE_WRITE_KEY` set, put the same value in `PRISM_WRITE_KEY`.
7. Save, then Connect.

The pixel calls `analytics.subscribe('checkout_completed', ...)` and `browser.cookie.get`, which are the [Shopify web pixel APIs](https://shopify.dev/docs/api/web-pixels-api). Shopify runs the pixel in a sandbox. It sends the order id, the checkout total, and the currency. It does not send the buyer email or address.

An order is stored once per site and order id. Prism credits it to each variant, and to the control arm, that the visitor had already seen on that site. A visitor with no impression is dropped. Revenue, RPV, and AOV in `/api/stats` stay split by currency.

`POST /api/events` accepts `{ "type": "order", "orderId": "gid://shopify/Order/1", "value": "48.00", "currency": "USD" }` inside the usual `events` array. `value` is a decimal amount. Prism stores integer minor units.

Install this only on a store you control. A development store is the place to try a test order. `tests/fixtures/shopify-checkout-completed.json` is a recorded `checkout_completed` payload for a local replay when no development store is available.

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
| `/api/events` | POST | write key | impressions, conversions, and orders (sendBeacon-safe) |
| `/api/variants` | GET/POST | token or session for that site; POST writes need admin, editor, or the demo token on `demo` | list / create variants |
| `/api/variants/:id/toggle` · `DELETE /api/variants/:id` | | token; demo token only for `demo` variants | pause / remove |
| `/api/stats?site=` | GET | token or session for that site | per-variant click rate, orders, RPV, and AOV, with 95% intervals, plus holdout control |
| `/api/sites` | GET | token or session; demo token lists `demo` only | site slugs the caller may see |
| `/api/export?site=` | GET | token or session for that site | full tenant dump (variants, events, visitors) |
| `/api/visitors/:id?site=` | GET/DELETE | token or session for that site; demo token only for `demo`; readonly tokens cannot delete | GDPR/CCPA export & erasure |
| `/api/sites/:site/plan` | POST | admin token or owner session | set a site's plan (`{plan: "growth"}`) |
| `/api/pilot/billing-status` | GET | admin token or owner session | `{ mode, effectiveMode, priceShown }` for the pilot pay button |

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
