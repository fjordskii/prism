# ISSUES — Prism pricing-claim audit (2026-10-07)

Found by code audit + curl battery + `npx e2e explore` (run 01a1173d, claude-haiku-4-5;
run truncated at step 3/12 by Anthropic credit exhaustion, findings so far kept).

| ID | Sev | Claim / area | Issue | Evidence | Status |
|----|-----|--------------|-------|----------|--------|
| I-1 | **critical** | "pin the versioned immutable URL" + published SRI hash | Published `integrity="sha384-sEOeqZqZMmjwTITEcrUuexOimOEll5rmghxk6GjYE+NDqAxY0RijflDuYm6gty5i"` (landing/index.html:377, panel/brief.md) does NOT match `public/snippet.js`. Actual: `sha384-g8aa4Fhxe/l9XqedTYl+17fbXzXZ5YoQFCE93vdQhe9CIXaPRoXBoBJEmRV1+rlB`. Any site using the published tag gets a **blocked script** — total product failure on install. | `openssl dgst -sha384 -binary public/snippet.js \| openssl base64` | fixed & verified |
| I-2 | **high** | Admin dashboard authoring loop | `authFetch()` in src/dashboard.ts never attaches the `?token=` credential, so every Create/Edit/Pause/Delete from `/admin?token=…` → `401 {"error":"unauthorized"}` whenever ADMIN_TOKEN is set (i.e. production). | curl: `POST /api/variants/1/toggle` no token → 401; e2e finding #1 "Unauthorized error shown in variant creation form" (screenshot: .e2e-audit/artifacts/.../finding-1.png) | fixed & verified |
| I-3 | **high** | "Klaviyo snippet uses real Liquid fields, computed lastOrderDays" | The one-liner `{{ 'now' \| date:'%s' \| minus: customer.last_order.created_at \| date:'%s' \| divided_by:86400 }}` renders `20733.7` for a customer whose true lastOrderDays ≈ 17. Liquid filter args cannot themselves be filtered; the `date:'%s'` applies to the subtraction result, not to `created_at`. | liquidjs render test, /tmp/liquid-check | fixed & verified |
| I-4 | **high** | All tier limits: 10k/100k/500k/1M visitors, 1/3/5/unlimited sites, "per-site caps", Shadow "tracking only, no personalization" | No plans table, no usage metering, no enforcement anywhere. Any deployment accepts unlimited sites (verified: 6 sites created, all 201) and unlimited visitors; shadow mode does not exist; "/api/decide" always personalizes. | src/db.ts schema (no plans), src/server.ts (no cap checks), live curl | fixed & verified |
| I-5 | **medium** | Shadow tier: "segment discovery" | No endpoint or UI surfaces discovered audience segments; visitors' traits are stored but never aggregated. | grep: no segment aggregation in src/ | fixed & verified (folded into I-4 stats work) |
| I-6 | **medium** | "Conversions only recorded with a matching prior impression" | Integrity check is skipped for control conversions (`variantId=null`): `if (e.type === "conversion" && e.variantId != null)`. Anyone can inflate the control arm and make personalization look worse. | src/server.ts /api/events | fixed & verified |
| I-7 | **low** | README API table | `/api/visitors/:id` auth column says "—" but endpoints are token-gated since round 3 (verified 401 without token). | README.md vs src/server.ts | fixed & verified |
| I-8 | **low** | Visitor upsert | `insVisitor` uses `ON CONFLICT(id)` but `id` is the global PRIMARY KEY while visitors are per-site; a cross-site id collision bumps `visits` on the wrong site's row and drops the new site's traits. | src/server.ts:28-31 vs db.ts schema | fixed & verified |
| I-9 | **low** | Agency: "read-only seats" | No role concept; only ADMIN_TOKEN (full write) and DEMO_TOKEN (demo-site write). No read-only credential exists to give a client a seat. | src/server.ts auth | fixed & verified (folded into I-4 auth work) |
| I-10 | info | SLA 99.9% auto-credits, renewal price lock, overage contact | Policy text in /terms only; no billing/telemetry code exists to automate. Acceptable as policy, but "applied automatically" and "we contact you when over" require the usage metering from I-4 to be actionable. | /terms text | documented; usage metering landed with I-4 (`/api/stats` exposes `usage.overLimit`, making "we contact you" actionable) |
| I-11 | info | e2e coverage | `npx e2e explore` truncated at step 3/12 (Anthropic credit balance). Landing pricing + demo storefront steps completed; admin edit flow not reached by the agent (covered manually via curl instead). | .e2e-audit/report.json | noted |

Legend: ✅ true · ⚠️ partial/unenforced · ❌ false — see AUDIT-2026-10-07.md for the full claim table.

## Fix verification (2026-10-07, local instance PRISM_PLAN=shadow ADMIN_TOKEN/DEMO_TOKEN/READONLY_TOKENS set)

- Server boot prints `snippet.v1.js SRI: sha384-g8aa4Fhxe/…` matching the now-published hash (I-1, T9).
- Headless-browser: `/admin?token=…` toggle via the page's own `authFetch` → 200 (was 401); plan line and Segments section render with live data (I-2, I-5).
- Site cap: variant create for 2nd site → `402 {error:"site_cap",cap:1}`; bypass via prior `/api/decide` closed (sitePlan is read-only) (I-4).
- Shadow plan: `/api/decide` → 200 `{decisions:[], shadow:true}`, tracking continues; usage metering counts unidentified visitors; overLimit flips true at 10,004/10,000 (I-4).
- Read-only token: `/admin` 200, `/api/export` 200, DELETE visitor 401, plan change 401 (I-9).
- Control-arm conversion without prior control impression → `recorded:0` (I-6).
- Headless-browser: `/demo/` with `prism.identify({intent:"gift"})` swaps `#hero` to the gift variant (end-to-end loop intact post-changes).
- Klaviyo Liquid rewrite verified against liquidjs (renders ~17 days for a 17-day-old order, was 20733) (I-3).
