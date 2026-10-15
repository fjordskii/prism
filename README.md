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
| `SITE_WRITE_KEY` | unset | legacy shared ingest key. Accepted with a warning until `SITE_WRITE_KEY_GRACE_UNTIL` |
| `SITE_WRITE_KEY_GRACE_UNTIL` | open if unset | epoch ms after which `SITE_WRITE_KEY` is rejected |
| `HOLDOUT_PCT` | `10` | default % of visitors held out as control for each audience and selector. A site can override it. The default stays 10. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset (OAuth off) | Google OAuth client; enables `/auth/login` for browser access |
| `GOOGLE_ALLOWED_EMAILS` | unset | comma list. `email` and `email:role` are deployment-wide (`owner`, `editor`, or `viewer`; default `editor`). `email:role@site` adds one grant. Several sites are separated by a vertical bar. A broken suffix is skipped. Seed is insert-only |
| `SESSION_SECRET` | `ADMIN_TOKEN` | signs session cookies; rotate to revoke all sessions |
| `BASE_URL` | request origin | external origin for the OAuth redirect URI (set behind a proxy) |
| `DEV_AUTH_EMAIL` | unset | local dev only: `/auth/dev-login` signs in as this email, no Google round-trip. NEVER set in production |
| `PRISM_PLAN` | `selfhost` | plan assigned to newly-registered sites (`selfhost` = unlimited) |
| `READONLY_TOKENS` | unset | comma list. An unsuffixed token is not trimmed and reads every site. A token with `@` and a site list reads only those sites; the bearer is the text before `@`. A bad suffix is skipped. A duplicate secret fails boot |
| `BILLING_MODE` | `off` | `off`, `test`, or `live`. `off` shows no pay button |
| `PILOT_PAYMENT_LINK` | unset | Stripe Payment Link URL. Test mode accepts only a URL that starts with `https://buy.stripe.com/test_` |
| `BILLING_LIVE_APPROVED` | unset | set to `yes` before `BILLING_MODE=live` shows a pay button |
| `GROWTH_RATE_PER_MIN` | `DECIDE_RATE_PER_MIN`, else `600` | per-client cap for `POST /api/growth` |
| `S3_ENDPOINT` | unset | S3 API URL. Unset, the daily snapshot skips and uploads nothing |
| `S3_BUCKET` | unset | bucket name. One DNS label |
| `S3_ACCESS_KEY_ID` | unset | access key that can list, put, get, and delete in that bucket |
| `S3_SECRET_ACCESS_KEY` | unset | secret for that access key |
| `S3_REGION` | `auto` | region on the S3 signature. Tigris uses `auto` |
| `BACKUP_RETENTION_DAYS` | `14` | UTC days to keep, including today. An integer from 1 to 30 |
| `BACKUP_TOKEN` | unset | bearer for `POST /internal/backup`. Unset, the route returns 401 |

## Off-volume backup

The backup workflow runs at 08:15 UTC. `workflow_dispatch` runs the same job. It requests `https://prism-personalize.fly.dev/snippet.js`, then POSTs `/internal/backup` with `Authorization: Bearer $BACKUP_TOKEN`. GitHub stores that token and no S3 key. If the GitHub secret is empty, the job prints `BACKUP_TOKEN is unset; snapshot skipped.` and exits 0.

Before the S3 secrets exist, the same POST returns HTTP 200.

```json
{"ok":true,"skipped":true,"reason":"missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}
```

A wrong bearer returns HTTP 401. A snapshot that ran and failed returns HTTP 500. Some S3 fields set and others missing is also HTTP 500, so the daily job goes red.

Restore writes a new file. It does not replace the live database. The procedure is in [docs/backup-restore.md](docs/backup-restore.md).

```sh
fly machine start -a prism-personalize
fly ssh console -a prism-personalize -C \
  "bun src/backup.ts restore --date 2026-10-14 --to /data/prism.restore"
fly machine restart -a prism-personalize
```

Omit `--date` to restore the newest object. Restart runs `adopt` before `seed` opens the database. `restore` refuses `--to` when that path is the live database or a side file (`-wal`, `-shm`, `-journal`, `.previous` and timestamped generations), including after symlink and hardlink resolution and a case-insensitive match. A dangling symlink whose target is one of those side files is also refused. It also refuses a file named `prism.db`. `adopt` proves a candidate with a DB-only check (integrity, migrate, startup prepares, counts) on a copy on the same volume; env/config is validated separately. An empty, corrupt, schema-less, or wrong-column file is moved to `/data/prism.restore.rejected` and live is left untouched. A config error (duplicate `READONLY_TOKENS`, unknown `PRISM_PLAN`) fails boot with live untouched. Copy, disk-full, timeout, or other prove-environment failures leave live and `prism.restore` in place and skip seed. A proof that overruns the timeout is SIGKILL'd and its result is ignored. A successful swap keeps the displaced live file at `prism.db.previous.<timestamp>` (last three by timestamp). If live cannot boot, adopt walks those generations newest to oldest; if none of them boot, it exits 1 so seed cannot create an empty database while a generation or quarantined file is still on the volume. `--day` in the future is refused so retention cannot prune real objects.

The MinIO drill is `tests/drill/backup-restore.test.ts`. It is not part of `tests/unit`, so a MinIO failure does not block deploy.

This change does not create a bucket, set secrets, or deploy. Do these once, in order.

1. Create a private Tigris bucket on the free tier. Use endpoint `https://t3.storage.dev` and region `auto`. The bucket name is one DNS label.
2. Create an access key that can list, put, get, and delete objects in that bucket only.
3. Set Fly secrets on `prism-personalize` for `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION=auto`, `BACKUP_RETENTION_DAYS=14`, and a new random `BACKUP_TOKEN`.
4. Deploy this build so `POST /internal/backup` exists on the app.
5. Set the GitHub secret `BACKUP_TOKEN` to that same token only after that deploy. Do not put the S3 keys in GitHub. Until the Fly S3 secrets exist, the route returns the skip receipt and uploads nothing. If the GitHub secret is set before the route is live, the daily job gets HTTP 404 and fails.

## Auth model

- **Humans**: Google sign-in when `GOOGLE_CLIENT_ID`/`SECRET` are set. `/auth/login` sets a session cookie. An account with no `account_sites` rows is deployment-wide, and `accounts.role` applies on every site: `owner` (plan changes and the operator pages), `editor` (variant writes on existing sites), `viewer` (reads). Any `account_sites` row scopes that person to those sites and `accounts.role` is ignored.
- **Pilot stores** are onboarded only as site-scoped accounts. The deployment-wide grant is for the operators.

```
GOOGLE_ALLOWED_EMAILS=ford@x.com:owner,ada@shop.com:owner@ada,ben@shop.com:editor@ada|ada-eu
READONLY_TOKENS=audit-all,ada-ro@ada|ada-eu
```

The bearer for the second readonly token is `ada-ro`. `PUT /api/account-sites` and `DELETE /api/account-sites` with the admin token change a grant. Deleting the last grant also deletes the `accounts` row. A grant that is still in `GOOGLE_ALLOWED_EMAILS` returns on the next boot, because seed is insert-only.
- **Agents and scripts**: `Authorization: Bearer $ADMIN_TOKEN` is deployment-wide. `DEMO_TOKEN` reaches only site `demo`. `READONLY_TOKENS` are read-only. `?token=` still works.
- Unset `ADMIN_TOKEN` and leave OAuth off, and the deployment is open (local-dev default).
- Snapshot `prism.db` before you deploy. The file sits on one Fly volume.

## Turn on pilot payment

The pay button stays off until you set the link, the mode, and, for a real charge, the approval flag. The app does not call Stripe. `PILOT_PAYMENT_LINK` is the Payment Link URL, and the button is that link. Prices and the offer sentences live in `src/offer.ts`.

1. In Stripe, create a Payment Link. Set its confirmation page to `https://prism-personalize.fly.dev/pilot/thanks`.
2. For a test charge, the link has to start with `https://buy.stripe.com/test_`. Set the link and the mode.

```sh
fly secrets set PILOT_PAYMENT_LINK="https://buy.stripe.com/test_..." BILLING_MODE=test
```

3. Sign in as a deployment-wide owner and open `/pilot`. The page shows "Pay for the pilot". Open `/pilot` in a private window. The button is absent, and the inquiry form is still there.
4. Check the mode with the admin token. `effectiveMode` is `test` when the link is a test link. It is `off` when the link is missing or is not a test link. `priceShown` is true only when the caller would see the pay button. In test mode, that caller is a deployment-wide owner session, so a token-only request reports `priceShown` false.

```sh
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://prism-personalize.fly.dev/api/pilot/billing-status
```

5. To charge a real card, create a live Payment Link on `https://buy.stripe.com/` whose URL does not start with `https://buy.stripe.com/test_`. Then set the approval flag and the mode. Until `BILLING_LIVE_APPROVED` is `yes`, live mode behaves as off.

```sh
fly secrets set PILOT_PAYMENT_LINK="https://buy.stripe.com/..." BILLING_LIVE_APPROVED=yes BILLING_MODE=live
```

6. Smoke test. `effectiveMode` in the status response is `live`, and a logged-out visit to `/pilot` shows "Pay for the pilot". After payment, Stripe sends the buyer to `/pilot/thanks`.

## Landing counts

The landing page and `/pilot` record five events so you can count pilot demand per week. The count is first-party. It sets no cookie and stores no IP address. A reload counts again.

| Event | When it is recorded |
|---|---|
| `landing_view` | A browser loads `/` or `/landing/` |
| `pilot_cta` | A click on a pricing card's "Book a pilot" link |
| `pilot_view` | A browser loads `/pilot` |
| `pilot_inquiry` | A valid pilot inquiry is stored |
| `snippet_copy` | A click on the install snippet's Copy button |

Each row stores the UTC day, `utm_source`, `utm_medium`, `utm_campaign`, and the host of the referring site. The path of the referrer is dropped. An IP address in the referrer is dropped.

`POST /api/growth` is public. The pages call it with `sendBeacon` and ignore failures, so a counting error does not break the page. The JSON body is at most 1024 bytes:

```json
{
  "event": "landing_view",
  "utm_source": "newsletter",
  "utm_medium": "email",
  "utm_campaign": "oct",
  "referrer": "https://mail.google.com/mail"
}
```

`event` has to be one of the five names above. Any other name, a body over 1024 bytes, or a client over the per-minute cap is rejected and not stored. The cap is 600 requests a minute per client IP, the same window as `POST /api/decide`.

Read the counts with the admin token or a deployment-wide owner session. A site-scoped account gets 403. Any other caller gets 401. `from` and `to` are inclusive UTC dates (`YYYY-MM-DD`). If you omit them, the range is the last 90 days through today.

```sh
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://prism-personalize.fly.dev/api/growth?from=2026-10-01&to=2026-10-12"
```

```json
{
  "from": "2026-10-01",
  "to": "2026-10-12",
  "days": [
    {
      "day": "2026-10-12",
      "events": {
        "landing_view": {
          "count": 4,
          "utm": [
            {
              "source": "newsletter",
              "medium": "email",
              "campaign": "oct",
              "referrerHost": "mail.google.com",
              "count": 3
            }
          ]
        }
      }
    }
  ]
}
```

Days and events with a count of zero are left out. `utm` is the breakdown for that day and event. `?token=` works on this route the same way it does on the other admin routes.

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
<!-- in <head>. data-selectors lists every section Prism may change -->
<script defer src="https://YOUR_HOST/snippet.js" data-site="yourstore" data-key="YOUR_WRITE_KEY" data-selectors="#hero,#grid"></script>
<script>
(function () {
  var tag = document.querySelector("script[data-selectors]");
  if (!tag || document.getElementById("prism-veil")) return;
  var parts = tag.getAttribute("data-selectors").split(","), css = [], i, s;
  for (i = 0; i < parts.length; i++) {
    s = parts[i].replace(/^\s+|\s+$/g, "");
    if (!s || s.length > 200 || /[{}<>\\]/.test(s)) continue;
    css.push(s + "{visibility:hidden !important}");
  }
  if (!css.length) return;
  var st = document.createElement("style");
  st.id = "prism-veil";
  st.textContent = css.join("");
  document.head.appendChild(st);
  var ms = +tag.getAttribute("data-timeout") || 800;
  window.__prismVeilUntil = Date.now() + ms;
  window.__prismVeilTimer = setTimeout(function () {
    window.__prismVeilTimedOut = true;
    if (st.parentNode) st.remove();
  }, ms);
})();
</script>
```

Copy `data-key` from `/admin`. Identify and event posts without that site's key are rejected.

`data-timeout` is milliseconds (default 800). The inline script hides only those selectors before first paint. The snippet removes the hide when it applies the decision. If the request is still pending when the timer fires, the default stays for that pageview and the late answer is cached for the next one. Omit `data-selectors` and the snippet keeps the old post-paint behavior.

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
6. Put the site's write key from `/admin` in `PRISM_WRITE_KEY`. During the grace window the old shared `SITE_WRITE_KEY` still works.
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
| `/api/identify` | POST | that site's write key (`x-prism-key`) | upsert visitor traits |
| `/api/decide` | POST | — | audience match → bandit pick per selector |
| `/api/events` | POST | that site's write key (`x-prism-key`) | impressions, conversions, and orders (sendBeacon-safe) |
| `/api/variants` | GET/POST | token or session for that site; POST writes need admin, editor, or the demo token on `demo` | list / create variants |
| `/api/variants/:id/toggle` · `DELETE /api/variants/:id` | | editor on that variant's site; a non-member gets 404; demo token only for `demo` | pause / remove |
| `/api/stats?site=` | GET | token or session for that site | per-variant click rate, orders, RPV, and AOV, with 95% intervals, pooled holdout, and a per-audience comparison |
| `/api/sites` | GET | token or session; demo token lists `demo` only | site slugs the caller may see |
| `/api/export?site=` | GET | token or session for that site | full tenant dump (variants, events, visitors) |
| `/api/visitors/:id?site=` | GET/DELETE | token or session for that site; demo token only for `demo`; readonly tokens cannot delete | GDPR/CCPA export & erasure |
| `/api/sites/:site/plan` | POST | admin token or a deployment-wide owner | set a site's plan (`{plan: "growth"}`) |
| `/api/sites/:site/holdout` | POST | owner on that site, or the admin token | set that site's holdout percent (`{holdoutPct: 30}`) or clear it (`{holdoutPct: null}`) so the deployment default applies |
| `/api/sites/:site/write-key` | GET/POST | owner on that site, or the admin token | view or rotate that site's snippet write key |
| `/api/sites/:site/lift-report` | GET | owner on that site, or the admin token | lift report for that site only. `format` is `json` (default), `html` (printable page), or `csv` |
| `/api/pilot/billing-status` | GET | admin token or a deployment-wide owner | `{ mode, effectiveMode, priceShown }` for the pilot pay button |
| `/api/growth` | POST | — | count a landing or pilot event (allowlisted name, 1024-byte cap, per-client rate limit) |
| `/api/growth?from=&to=` | GET | admin token or a deployment-wide owner | daily counts per event, with UTM and referrer-host breakdown |

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
`{"plan": "growth"}` (admin token or a deployment-wide owner; 400 on an unknown plan). A site-scoped account cannot register a new site. An unsuffixed `READONLY_TOKENS` entry reads every site. `token@site1|site2` reads only those sites. Both reject every mutation.

## Design invariants

- Variants are pre-approved content, never generated at request time.
- Listed sections hide until the decision is applied. A timeout (800 ms, or `data-timeout`) shows the default page and leaves it there. API failure shows the default page (fail open). The rest of the page is not held. Every DOM op is try/caught.
- Repeat views personalize from a 5-min localStorage cache, applied as soon as the script runs.
- SPA-aware: re-decides on pushState/popstate, re-applies after framework re-renders.
- Selection = Thompson sampling over Beta(conversions+1, impressions−conversions+1).
  Each audience and selector has a deterministic holdout, so the comparison has its own control group.
  The deployment default is 10%. A site can set its own percentage.

## License

Business Source License 1.1 — free to self-host for your own sites; you may not
sell Prism as a competing hosted service. Converts to Apache 2.0 on 2030-10-06.
