# Port onto production main (795c0ec)

The suite and the fixes below were re-applied onto the production auth, plans, and dashboard.
Main's auth model, plan enforcement, and dashboard structure were kept. Where production had
already fixed the same bug differently, that version was kept: PRISM-010 stays the dashboard's
`?token=` `authFetch` (now also used for catalog reads), and PRISM-012 is the SRI of the snippet
this branch actually serves.

| ID | Status on this branch |
|---|---|
| PRISM-002 | Fixed. Demo token is site `demo` only on export, visitor GET/DELETE, variant writes, plan changes, and catalog reads. Literal removed from committed docs ("demo token (ask operator)"). Source default is `DEMO_TOKEN`, with the historical literal only when the env var is unset. TODO: rotate with a Fly secret. |
| PRISM-003 | Open. No signup or checkout. `bun run test:e2e:bugbash` still expects this to fail. |
| PRISM-004 | Fixed. `identify()` re-decides only after the trait write, and an expired cache is applied. |
| PRISM-005 | Fixed. Visitor erasure runs its transaction. |
| PRISM-006 | Fixed. Click attribution credits the named selector. Control conversions already required a control impression on main. `sendBeacon` is skipped when a write key is set. |
| PRISM-007 | Open. `/api/decide` still scans events per candidate. Not part of this port. |
| PRISM-010 | Fixed on main (query-token `authFetch`). Kept; not duplicated with an Authorization header. Catalog reads now go through it too. |
| PRISM-011 | Fixed. Edit pre-fills `datetime-local` in local time. |
| PRISM-012 | Fixed. Landing page and `panel/brief.md` pin the hash of the current snippet. |
| PRISM-013 | Confirmed. All three `/architecture` diagrams parse under Mermaid 11. The semicolon called out in the original note is already a period in prod. An e2e check logs in with the harness token and fails if any `.mermaid` block shows "Syntax error". |
| PRISM-014 | Fixed. Demo store mobile layout, and "New visitor" wipes the cookie instead of merging traits. |
| PRISM-015 | Fixed. `GET /api/sites`, `/api/variants`, and `/api/stats` require a token or session. The demo token only sees `demo`. Snippet runtime stays public. Fly's health check moved off `/api/stats` onto `/snippet.js`. |
| PRISM-016 | Fixed. Malformed JSON is 400. Unknown event types are dropped. |

Accounts and `READONLY_TOKENS` are still deployment-wide (the gap called out on `/architecture`). The demo token is the credential scoped to one site.

Gating command: `bun run test:e2e` (desktop 1280×720 and mobile 390×844), Node.js 24.21.0, e2e 0.18.0.

**58 passed / 0 failed** (29 tests × 2 targets). The returning-customer check is deterministic: this environment's GitHub token cannot sign in to Copilot (it is a GitHub App installation token, and Copilot rejected it). The test still requires "Welcome back.", "Subscribe & save 15%", and the Start subscription button, which is the outcome the agent step was judging. `bun run test:e2e:bugbash` is still the open PRISM-003 repro and is not part of this total.

# Prism e2e + bug bash report: 2026-10-07

Tested with the `e2e` runner (v0.18.0, Playwright Chromium). There are two targets, desktop at 1280x720 and mobile at 390x844, both pointed at a local server with a freshly seeded SQLite DB (`tests/support/serve.ts`). Agent steps and the explore charters ran on a GitHub Copilot subscription model (`gpt-5.4-mini`). All other checks are deterministic Playwright and API assertions.

Run it with `bun run test:e2e`, which runs the gating suite. `bun run test:e2e:bugbash` runs the open bug repros, which are expected to fail until fixed.

## Results per flow (desktop + mobile)

| Flow | Tests | `main` @ 4742403 | This branch |
|---|---|---|---|
| Landing: hero, CTAs, pricing tiers, fits viewport, trust pages | `tests/landing.e2e.ts` | PASS | PASS |
| Demo storefront: persona → personalized hero/grid/strip | `tests/demo-personas.e2e.ts` | **FAIL** (5/6 fail; the persona variant only shows on the 3rd pageview, and mobile scrolls sideways by 123px) | PASS |
| Admin dashboard: locked w/o token, list, create from template, pause | `tests/admin.e2e.ts` | **FAIL** (create and pause return 401: the dashboard never sends its token) | PASS |
| Runtime + admin API: decide, events integrity, stats CIs, write auth, snippet headers | `tests/api.e2e.ts` | PASS | PASS |
| Regression: DSR erase, demo-token scope, control-conversion integrity, malformed JSON, SRI hash, CTA attribution, Edit TZ | `tests/regression/*` | **FAIL** (7/7) | PASS |
| Buying path: "Start free" leads to signup | `tests/bugbash/pricing-cta.e2e.ts` | FAIL | FAIL (open: needs signup + billing) |

Totals: `main` had 29 failed / 23 passed. This branch's gating run has 52 passed / 0 failed. That count includes one agent test per target, at about 12k tokens total.

## Confirmed bugs (each proven by a test that failed on `main`)

| ID | Sev | Bug | Root cause | Status |
|---|---|---|---|---|
| PRISM-002 | High | The public demo token (published in `panel/brief.md`) can export and DSR-read/erase **any** site. Also reproduced read-only on production (`/api/export?site=<any>` with the demo token returns 200). | `authorized(c, true)` is used on export/visitors with no site check (`src/server.ts`) | Fixed on branch. **Prod still exposed.** |
| PRISM-004 | High | Picking a persona (or calling `prism.identify`) shows the previous visitor's decision. The new variant only appears on the 3rd pageview. When the cache is expired, nothing is applied at all. | `identify()` called `decide()` before the trait write landed, then cached the stale result. `decide()` never applied fresh results when any cache entry existed, even an expired one. | Fixed |
| PRISM-005 | High | `DELETE /api/visitors/:id` returns ok but deletes nothing. The GDPR erasure claim is false. | The transaction was built but never invoked | Fixed |
| PRISM-010 | High (repo) | Dashboard create/pause/delete return 401 whenever `ADMIN_TOKEN` is set | `authFetch` didn't attach the token (prod already has a fix) | Fixed |
| PRISM-012 | High | The pinned-install snippet on the landing page has an SRI hash that matches no version of the snippet, so browsers refuse to load it | Hash went stale after snippet edits (prod already patched) | Fixed (hash recomputed) |
| PRISM-006 | Medium | The returning-customer CTA (an insertAfter strip) books a **control** conversion, and control conversions are accepted with no control impression. Both inflate the holdout and corrupt lift. | Click handler credited the clicked element's container, not the named selector. Server only checked impressions for non-null variants. | Fixed |
| PRISM-011 | Medium | Admin "Edit" pre-fills the start/end dates shifted by the UTC offset, by 5h in ET | `toISOString()` used for a `datetime-local` input | Fixed |
| PRISM-014 | Medium | On phones the demo store scrolls sideways (123px), the banner covers the nav, and the simulator covers the products. "New visitor (reset traits)" doesn't reset, because traits merge. | Desktop-only CSS; identify merges traits | Fixed |
| PRISM-016 | Low | Malformed JSON → 500; unknown event types are stored | No error handler or type validation | Fixed |
| PRISM-003 | High (selling) | Every pricing CTA ("Start free", "Start growing", "Go Pro") dead-ends at a token or Google-login wall. There is no signup and no checkout. | Not built | Open |
| PRISM-013 | Low | `/architecture` Mermaid diagram 1 shows "Syntax error in text" | A `;` inside a sequence-diagram `Note` is a statement separator. Verified with mermaid 11.17.2: replacing `(idempotent);` with `(idempotent),` parses OK. | Open: the file exists only in the unpushed prod code |

Found by code review and proven outside the e2e runner:
- PRISM-007: `/api/decide` scans every event per candidate variant. At 2M events, a decide takes **114 ms** (bun, 5 matching variants). That's about 3 months of one Growth customer.
- Events posted via `sendBeacon` on page exit are rejected whenever `SITE_WRITE_KEY` is on, because `sendBeacon` can't send the header. This was fixed on the branch but wasn't exercised end to end.

## Bug bash (7 `e2e explore` charters, 5 steps each)

Charters: demo personas (skeptic), admin input fuzzing (twice, since the first run was aborted), admin edit/schedule/pause state (twice, same reason), landing claims vs /terms and /security on mobile (skeptic), and mobile shopper.

Findings and how I sorted them:
- Kept: the mobile banner and simulator covering content (became PRISM-014). Blank variant submit shows a raw JSON error (became PRISM-016, low). Pricing CTAs go to a locked /admin (became PRISM-003).
- Rejected as explorer artifacts: "Live demo leaves homepage visible" (that link opens a new tab). "Security page understates snippet size" (both pages say 9 KB / 3 KB gzipped).
- Rejected as by design: "Wipe leaves the old hero visible momentarily" (a 0.7s toast before the reload).
- Did not reproduce: "Paused variant active after reload". The agent paused one of two same-named rows. Edit → Create makes a duplicate by design, and `tests/admin.e2e.ts` proves pause persists. I filed it as UX debt (Edit should update in place).

Not reached: Google login, plans and metering (those exist only on production, not on GitHub `main`); a real Shopify/Klaviyo install; load from multiple machines.
