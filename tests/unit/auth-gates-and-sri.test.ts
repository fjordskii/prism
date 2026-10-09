// Auth gates, demo-token scope, snippet SRI, and plan enforcement.
// In-process, same throwaway env as decide-and-cookies.test.ts. OAuth is on
// (fake Google client; no network). `bun test` shares one module registry, and
// that file imports the app first, so allowlisted accounts are inserted here.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN = "unit-admin-token";
const DEMO = "unit-demo-token";
const OWNER = "owner@prism.test";
const VIEWER = "viewer@prism.test";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-unit-")), "prism.db");
process.env.ADMIN_TOKEN = ADMIN;
process.env.DEMO_TOKEN = DEMO;
process.env.HOLDOUT_PCT = "0";
process.env.PRISM_PLAN = "selfhost";
process.env.GOOGLE_CLIENT_ID = "unit-client-id";
process.env.GOOGLE_CLIENT_SECRET = "unit-client-secret";
process.env.GOOGLE_ALLOWED_EMAILS = `${OWNER}:owner,${VIEWER}:viewer`;
process.env.DECIDE_RATE_PER_MIN = "20";
process.env.DECIDE_NEW_VISITORS_PER_HOUR = "5";
delete process.env.DEV_AUTH_EMAIL;
delete process.env.BASE_URL;

let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
let makeSession: (email: string) => Promise<string>;
beforeAll(async () => {
  await import("../../src/seed.ts");
  const { db } = await import("../../src/db.ts");
  const upsert = db.prepare(
    "INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role"
  );
  upsert.run(OWNER, "owner", Date.now());
  upsert.run(VIEWER, "viewer", Date.now());
  ({ default: app } = await import("../../src/server.ts"));
  ({ makeSession } = await import("../../src/auth.ts"));
});

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const origin = "http://127.0.0.1";
const cookieFor = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(name + "="));
const setsSession = (r: Response) => r.headers.getSetCookie().some((c) => c.startsWith("prism_session="));
const loginPath = (r: Response) => new URL(r.headers.get("location") ?? "", origin).pathname;
async function sessionCookie(email: string) {
  return `prism_session=${await makeSession(email)}`;
}

describe("auth gates", () => {
  test("with OAuth on, /admin, a wrong token, and /architecture redirect to /auth/login", async () => {
    for (const path of ["/admin", "/admin?token=wrong", "/architecture"]) {
      const r = await app.request(origin + path);
      expect(r.status).toBe(302);
      expect(loginPath(r)).toBe("/auth/login");
    }
  });

  test("a forged or non-allowlisted session cookie redirects to /auth/login", async () => {
    const forged = await app.request(origin + "/admin", { headers: { cookie: "prism_session=forged.not.a.jwt" } });
    expect(forged.status).toBe(302);
    expect(loginPath(forged)).toBe("/auth/login");
    const stranger = await app.request(origin + "/architecture", {
      headers: { cookie: await sessionCookie("stranger@example.com") },
    });
    expect(stranger.status).toBe(302);
    expect(loginPath(stranger)).toBe("/auth/login");
  });

  test("an allowlisted owner session gets /admin and /api/stats", async () => {
    const cookie = await sessionCookie(OWNER);
    expect((await app.request(origin + "/admin", { headers: { cookie } })).status).toBe(200);
    expect((await app.request(origin + "/api/stats?site=demo", { headers: { cookie } })).status).toBe(200);
  });

  test("a viewer session can read, but a variant write returns 401", async () => {
    const cookie = await sessionCookie(VIEWER);
    expect((await app.request(origin + "/api/stats?site=demo", { headers: { cookie } })).status).toBe(200);
    expect((await app.request(origin + "/api/variants?site=demo", { headers: { cookie } })).status).toBe(200);
    const write = await app.request(origin + "/api/variants", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ site: "demo", name: uid("viewer"), selector: "#nope", ops: "[]", audience: "[]" }),
    });
    expect(write.status).toBe(401);
  });

  test("/auth/login offers Google and no dev bypass", async () => {
    const r = await app.request(origin + "/auth/login");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('href="/auth/google"');
    expect(html).toContain("Sign in with Google");
    expect(html).not.toContain("/auth/dev-login");
    expect(html).not.toContain("Dev mode");
  });

  test("/auth/google redirects to Google with state, nonce, and a matching state cookie", async () => {
    const r = await app.request(origin + "/auth/google");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
    expect(loc.searchParams.get("response_type")).toBe("code");
    const state = loc.searchParams.get("state");
    const nonce = loc.searchParams.get("nonce");
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();
    const raw = cookieFor(r, "prism_oauth_state");
    expect(raw).toBeDefined();
    expect(decodeURIComponent(raw!.split(";")[0]!.slice("prism_oauth_state=".length))).toBe(`${state}:${nonce}`);
  });

  test("a callback with forged state, a missing cookie, or a missing code is 400 and sets no session", async () => {
    const start = await app.request(origin + "/auth/google");
    const pair = cookieFor(start, "prism_oauth_state")!.split(";")[0]!;
    const state = decodeURIComponent(pair.slice("prism_oauth_state=".length)).split(":")[0];

    const forged = await app.request(origin + "/auth/callback?state=forged&code=abc", { headers: { cookie: pair } });
    expect(forged.status).toBe(400);
    expect(setsSession(forged)).toBe(false);

    const missingCookie = await app.request(origin + "/auth/callback?state=forged&code=abc");
    expect(missingCookie.status).toBe(400);
    expect(setsSession(missingCookie)).toBe(false);

    const missingCode = await app.request(`${origin}/auth/callback?state=${state}`, { headers: { cookie: pair } });
    expect(missingCode.status).toBe(400);
    expect(setsSession(missingCode)).toBe(false);
  });

  test("/auth/dev-login is 404 when DEV_AUTH_EMAIL is unset", async () => {
    const r = await app.request(origin + "/auth/dev-login");
    expect(r.status).toBe(404);
    expect(setsSession(r)).toBe(false);
  });
});

describe("token gates", () => {
  const paths = [
    "/api/sites",
    "/api/variants?site=demo",
    "/api/stats?site=demo",
    "/api/export?site=demo",
    "/api/visitors/visitor-1?site=demo",
  ];

  test("catalog, export, and visitor reads are 401 with no credential, a wrong Bearer, or an empty Bearer", async () => {
    const creds: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer " }];
    for (const path of paths) {
      for (const headers of creds) {
        expect((await app.request(origin + path, { headers })).status).toBe(401);
      }
    }
  });

  test("the demo token reaches site demo and no other site", async () => {
    const demo = { authorization: `Bearer ${DEMO}` };
    for (const path of paths) {
      expect((await app.request(origin + path, { headers: demo })).status).toBe(200);
    }
    const sites = await (await app.request(origin + "/api/sites", { headers: demo })).json();
    expect(sites).toEqual(["demo"]);
    for (const path of ["/api/variants?site=other", "/api/stats?site=other", "/api/export?site=other", "/api/visitors/visitor-1?site=other"]) {
      expect((await app.request(origin + path, { headers: demo })).status).toBe(401);
    }
  });
});

describe("snippet SRI", () => {
  test("the integrity hash on / matches public/snippet.js and the served snippet URLs", async () => {
    const sri = async (bytes: BufferSource) =>
      "sha384-" + Buffer.from(await crypto.subtle.digest("SHA-384", bytes)).toString("base64");
    const file = new Uint8Array(await Bun.file("public/snippet.js").arrayBuffer());
    const html = await (await app.request(origin + "/")).text();
    const published = html.match(/integrity="(sha384-[^"]+)"/)?.[1];
    const snippet = await app.request(origin + "/snippet.js");
    const pinned = await app.request(origin + "/snippet.v1.js");
    expect(snippet.status).toBe(200);
    expect(pinned.status).toBe(200);
    const hash = await sri(file);
    expect(published).toBe(hash);
    expect(await sri(new Uint8Array(await snippet.arrayBuffer()))).toBe(hash);
    expect(await sri(new Uint8Array(await pinned.arrayBuffer()))).toBe(hash);
  });
});

describe("plan gates", () => {
  async function setPlan(site: string, plan: string, headers: Record<string, string>) {
    return app.request(`${origin}/api/sites/${site}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ plan }),
    });
  }

  test("only an admin token or an owner session can change a plan", async () => {
    const site = uid("plan");
    expect((await setPlan(site, "growth", {})).status).toBe(401);
    expect((await setPlan(site, "growth", { authorization: `Bearer ${DEMO}` })).status).toBe(401);
    expect((await setPlan(site, "growth", { cookie: await sessionCookie(VIEWER) })).status).toBe(401);
    expect((await setPlan(site, "no-such-plan", { authorization: `Bearer ${ADMIN}` })).status).toBe(400);
    const admin = await setPlan(site, "growth", { authorization: `Bearer ${ADMIN}` });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ ok: true, site, plan: "growth" });
    const owner = await setPlan(site, "pro", { cookie: await sessionCookie(OWNER) });
    expect(owner.status).toBe(200);
    expect((await owner.json()).plan).toBe("pro");
  });

  test("a Shadow-plan site returns no decisions and shadow:true", async () => {
    const site = uid("shadow");
    const created = await app.request(origin + "/api/variants", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ site, name: "Shadow candidate", selector: "#hero", ops: "[]", audience: "[]" }),
    });
    expect(created.status).toBe(201);
    const decide = (visitorId: string, headers: Record<string, string> = {}) =>
      app.request(origin + "/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json", "fly-client-ip": "10.9.0.8", ...headers },
        body: JSON.stringify({ visitorId, site }),
      });
    const open = await (await decide(uid("v"), { authorization: `Bearer ${ADMIN}` })).json();
    expect(open.decisions).toEqual([expect.objectContaining({ name: "Shadow candidate" })]);
    expect((await setPlan(site, "shadow", { authorization: `Bearer ${ADMIN}` })).status).toBe(200);
    const gated = await (await decide(uid("v"), { authorization: `Bearer ${ADMIN}` })).json();
    expect(gated.decisions).toEqual([]);
    expect(gated.shadow).toBe(true);
    expect(gated.plan).toBe("shadow");
  });
});
