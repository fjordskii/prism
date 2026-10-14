// Env grammar and the site-access status matrix. The server is not imported here.
// Each case boots in a child process so this file does not pin DB_PATH for the suite.
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFileIsolated } from "../support/isolated";

const ADMIN = "access-admin-token";
const DEMO = "access-demo-token";

if (process.env.PRISM_TEST_ISOLATED !== "1") {
  test("allowlist grammar, status matrix, and membership", async () => {
    await runFileIsolated(join(import.meta.dir, "access.test.ts"), { PRISM_ACCESS_CASE: "matrix" });
  }, { timeout: 60_000 });

  test("open mode lets an anonymous caller through and a viewer cookie still blocks writes", async () => {
    await runFileIsolated(join(import.meta.dir, "access.test.ts"), { PRISM_ACCESS_CASE: "open" });
  }, { timeout: 60_000 });

  test("a bad stored role stays site-scoped", async () => {
    await runFileIsolated(join(import.meta.dir, "access.test.ts"), { PRISM_ACCESS_CASE: "illegal" });
  }, { timeout: 60_000 });

  test("duplicate readonly tokens fail boot", async () => {
    const proc = Bun.spawn([process.execPath, "-e", "await import('./src/access.ts')"], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DB_PATH: join(mkdtempSync(join(tmpdir(), "prism-ro-")), "prism.db"),
        READONLY_TOKENS: "same,same",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("duplicate readonly token");
  });
} else if (process.env.PRISM_ACCESS_CASE === "illegal") {
  let requireSite: typeof import("../../src/access.ts").requireSite;
  let makeSession: typeof import("../../src/auth.ts").makeSession;

  beforeAll(async () => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-illegal-")), "prism.db");
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.DEMO_TOKEN = DEMO;
    process.env.READONLY_TOKENS = "";
    process.env.SESSION_SECRET = "illegal-session";
    process.env.GOOGLE_CLIENT_ID = "illegal-client";
    process.env.GOOGLE_CLIENT_SECRET = "illegal-secret";
    delete process.env.GOOGLE_ALLOWED_EMAILS;
    delete process.env.DEV_AUTH_EMAIL;
    const early = new Database(process.env.DB_PATH);
    early.exec(`
      CREATE TABLE accounts (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'editor',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE account_sites (
        email TEXT NOT NULL,
        site TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (email, site)
      );
      INSERT INTO accounts (email, role, created_at) VALUES ('bad@x.com', 'owner', 1);
      INSERT INTO account_sites (email, site, role) VALUES ('bad@x.com', 'ada', 'nope');
      INSERT INTO accounts (email, role, created_at) VALUES ('mix@x.com', 'owner', 1);
      INSERT INTO account_sites (email, site, role) VALUES ('mix@x.com', 'ada', 'editor');
      INSERT INTO account_sites (email, site, role) VALUES ('mix@x.com', 'nope', 'not-a-role');
    `);
    early.close();
    ({ requireSite } = await import("../../src/access.ts"));
    ({ makeSession } = await import("../../src/auth.ts"));
  });

  async function cookie(email: string) {
    return { req: headerCtx(`prism_session=${await makeSession(email)}`) };
  }

  test("dropping every illegal grant does not restore deployment scope", async () => {
    const bad = await cookie("bad@x.com");
    expect(await requireSite(bad, "ada", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(bad, "other", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  test("a legal grant is kept and accounts.role is ignored", async () => {
    const mix = await cookie("mix@x.com");
    expect(await requireSite(mix, "ada", "editor")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(mix, "ada", "owner")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(mix, "nope", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
  });
} else if (process.env.PRISM_ACCESS_CASE === "open") {
  let requireSite: typeof import("../../src/access.ts").requireSite;
  let requireDeployment: typeof import("../../src/access.ts").requireDeployment;
  let openAdmin: typeof import("../../src/access.ts").openAdmin;
  let makeSession: typeof import("../../src/auth.ts").makeSession;
  let db: typeof import("../../src/db.ts").db;

  beforeAll(async () => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-open-")), "prism.db");
    delete process.env.ADMIN_TOKEN;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_ALLOWED_EMAILS;
    delete process.env.DEV_AUTH_EMAIL;
    process.env.DEMO_TOKEN = DEMO;
    process.env.READONLY_TOKENS = "";
    process.env.SESSION_SECRET = "open-session";
    ({ requireSite, requireDeployment, openAdmin } = await import("../../src/access.ts"));
    ({ makeSession } = await import("../../src/auth.ts"));
    ({ db } = await import("../../src/db.ts"));
    db.prepare("INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?)").run("viewer@prism.test", "viewer", 1);
    db.prepare("INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?)").run("scoped@shop.test", "owner", 1);
    db.prepare("INSERT INTO account_sites (email, site, role) VALUES (?, ?, ?)").run("scoped@shop.test", "sitea", "owner");
  });

  test("anonymous open mode can read and mint", async () => {
    const anon = { req: headerCtx() };
    expect(await requireSite(anon, "shop", "editor")).toEqual({ ok: true, scope: "deployment", canRegisterSite: true });
    expect(await requireDeployment(anon)).toEqual({ ok: true });
    expect(await openAdmin(anon, undefined)).toEqual({
      kind: "html",
      boot: { sites: [], site: "demo", denied: false },
    });
  });

  test("a viewer cookie blocks a write and still passes the deployment gate", async () => {
    const viewer = { req: headerCtx(`prism_session=${await makeSession("viewer@prism.test")}`) };
    expect(await requireSite(viewer, "shop", "editor")).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireSite(viewer, "shop", "viewer")).toEqual({ ok: true, scope: "deployment", canRegisterSite: false });
    expect(await requireDeployment(viewer)).toEqual({ ok: true });
  });

  test("a site-scoped cookie wins over open mode on a site route", async () => {
    const scoped = { req: headerCtx(`prism_session=${await makeSession("scoped@shop.test")}`) };
    expect(await requireSite(scoped, "sitea", "owner")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(scoped, "shop", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireDeployment(scoped)).toEqual({ ok: true });
  });
} else {
  let requireSite: typeof import("../../src/access.ts").requireSite;
  let requireDeployment: typeof import("../../src/access.ts").requireDeployment;
  let requireAdminToken: typeof import("../../src/access.ts").requireAdminToken;
  let wideOwnerSession: typeof import("../../src/access.ts").wideOwnerSession;
  let listVisibleSites: typeof import("../../src/access.ts").listVisibleSites;
  let openAdmin: typeof import("../../src/access.ts").openAdmin;
  let parseAllowlist: typeof import("../../src/access.ts").parseAllowlist;
  let parseReadonlyTokens: typeof import("../../src/access.ts").parseReadonlyTokens;
  let seedAccounts: typeof import("../../src/access.ts").seedAccounts;
  let upsertMembership: typeof import("../../src/access.ts").upsertMembership;
  let deleteMembership: typeof import("../../src/access.ts").deleteMembership;
  let makeSession: typeof import("../../src/auth.ts").makeSession;
  let db: typeof import("../../src/db.ts").db;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-access-")), "prism.db");
    process.env.ADMIN_TOKEN = ADMIN;
    process.env.DEMO_TOKEN = DEMO;
    process.env.READONLY_TOKENS = "wide-ro,ada-ro@sitea|sitez,bad-ro@not a site";
    process.env.SESSION_SECRET = "access-session";
    process.env.GOOGLE_CLIENT_ID = "access-client";
    process.env.GOOGLE_CLIENT_SECRET = "access-secret";
    delete process.env.GOOGLE_ALLOWED_EMAILS;
    delete process.env.DEV_AUTH_EMAIL;
    ({
      requireSite, requireDeployment, requireAdminToken, wideOwnerSession, listVisibleSites, openAdmin,
      parseAllowlist, parseReadonlyTokens, seedAccounts, upsertMembership, deleteMembership,
    } = await import("../../src/access.ts"));
    ({ makeSession } = await import("../../src/auth.ts"));
    ({ db } = await import("../../src/db.ts"));
    const insAccount = db.prepare("INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?)");
    const insGrant = db.prepare("INSERT INTO account_sites (email, site, role) VALUES (?, ?, ?)");
    insAccount.run("owner@prism.test", "owner", 1);
    insAccount.run("editor@prism.test", "editor", 1);
    insAccount.run("viewer@prism.test", "viewer", 1);
    insAccount.run("site-editor@shop.test", "editor", 1);
    insAccount.run("site-viewer@shop.test", "viewer", 1);
    insAccount.run("site-owner@shop.test", "owner", 1);
    insGrant.run("site-editor@shop.test", "sitea", "editor");
    insGrant.run("site-viewer@shop.test", "sitea", "viewer");
    insGrant.run("site-owner@shop.test", "sitea", "owner");
    insGrant.run("site-owner@shop.test", "sitez", "owner");
    db.prepare(
      "INSERT INTO variants (site, name, selector, ops, audience, created_at) VALUES (?, ?, '#h', '[]', '[]', 1)"
    ).run("demo", "Demo hero");
    db.prepare(
      "INSERT INTO variants (site, name, selector, ops, audience, created_at) VALUES (?, ?, '#h', '[]', '[]', 1)"
    ).run("siteb", "B hero");
    for (const email of [
      "owner@prism.test", "editor@prism.test", "viewer@prism.test",
      "site-editor@shop.test", "site-viewer@shop.test", "site-owner@shop.test",
    ]) {
      cookies[email] = `prism_session=${await makeSession(email)}`;
    }
  });

  function as(email?: string, bearer?: string, token?: string) {
    return { req: headerCtx(email ? cookies[email] : undefined, bearer, token) };
  }

  test("allowlist grammar", () => {
    expect(parseAllowlist("ford@x.com:owner,ada@shop.com:owner@ada,ben@shop.com:editor@ada|ada-eu")).toEqual([
      { email: "ford@x.com", role: "owner", sites: null },
      { email: "ada@shop.com", role: "owner", sites: ["ada"] },
      { email: "ben@shop.com", role: "editor", sites: ["ada", "ada-eu"] },
    ]);
    expect(parseAllowlist(" plain@x.com ")).toEqual([{ email: "plain@x.com", role: "editor", sites: null }]);
    expect(parseAllowlist("Ada@X.com:viewer")).toEqual([{ email: "ada@x.com", role: "viewer", sites: null }]);
    expect(parseAllowlist("ada@x.com:nope")).toEqual([{ email: "ada@x.com", role: "editor", sites: null }]);
    expect(parseAllowlist("ada@x.com:owner@not a site,b@x.com")).toEqual([
      { email: "b@x.com", role: "editor", sites: null },
    ]);
    expect(parseAllowlist("ada@x.com:owner@ok|bad site")).toEqual([]);
    expect(parseAllowlist(":owner")).toEqual([]);
    expect(parseAllowlist("a@x.com:viewer@ ada | b ")).toEqual([
      { email: "a@x.com", role: "viewer", sites: ["ada", "b"] },
    ]);
  });

  test("readonly grammar keeps spaces on an unsuffixed secret and skips a bad suffix", () => {
    expect(parseReadonlyTokens("audit-all,ada-ro@ada|ada-eu")).toEqual(new Map<string, readonly string[] | null>([
      ["audit-all", null],
      ["ada-ro", ["ada", "ada-eu"]],
    ]));
    expect(parseReadonlyTokens(" wide ,scoped@ada")).toEqual(new Map<string, readonly string[] | null>([
      [" wide ", null],
      ["scoped", ["ada"]],
    ]));
    expect(parseReadonlyTokens("bad-ro@not a site")).toEqual(new Map());
    expect(parseReadonlyTokens(",,tok,")).toEqual(new Map<string, readonly string[] | null>([["tok", null]]));
    expect(() => parseReadonlyTokens("dup,dup")).toThrow("duplicate readonly token");
    expect(() => parseReadonlyTokens("dup@a,dup@b")).toThrow("duplicate readonly token");
    expect(() => parseReadonlyTokens("dup,dup@a")).toThrow("duplicate readonly token");
  });

  test("deployment, demo, and site grants", async () => {
    const allow = { ok: true as const, scope: "deployment" as const, canRegisterSite: false };
    expect(await requireSite(as(), "sitea", "viewer")).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireSite(as(undefined, `Bearer ${ADMIN}`), "sitea", "editor")).toEqual({
      ok: true, scope: "deployment", canRegisterSite: true,
    });
    expect(await requireSite(as(undefined, undefined, ADMIN), "", "editor", "missing")).toEqual({
      ok: true, scope: "deployment", canRegisterSite: true,
    });
    expect(await requireSite(as("editor@prism.test"), "siteb", "editor")).toEqual(allow);
    expect(await requireSite(as("editor@prism.test"), "", "editor", "missing")).toEqual(allow);
    expect(await requireSite(as("editor@prism.test"), "siteb", "owner")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(as("viewer@prism.test"), "siteb", "viewer")).toEqual(allow);
    expect(await requireSite(as("viewer@prism.test"), "siteb", "editor")).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireSite(as("viewer@prism.test"), "", "editor", "missing")).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireSite(as("viewer@prism.test"), "siteb", "owner")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(as("owner@prism.test"), "siteb", "owner")).toEqual({
      ok: true, scope: "deployment", canRegisterSite: true,
    });
    expect(await requireSite(as("viewer@prism.test", `Bearer ${ADMIN}`), "sitea", "editor")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });

    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "demo", "editor")).toEqual({
      ok: true, scope: "demo", canRegisterSite: false,
    });
    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "demo", "viewer")).toEqual({
      ok: true, scope: "demo", canRegisterSite: false,
    });
    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "demo", "owner")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "siteb", "viewer")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "siteb", "editor")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
    expect(await requireSite(as(undefined, `Bearer ${DEMO}`), "", "editor", "missing")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });

    expect(await requireSite(as("site-editor@shop.test"), "sitea", "editor")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as("site-editor@shop.test"), "sitea", "editor", "missing")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as("site-editor@shop.test"), "siteb", "viewer")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as("site-editor@shop.test"), "siteb", "editor", "missing")).toEqual({
      ok: false, status: 404, error: "not_found",
    });
    expect(await requireSite(as("site-editor@shop.test"), "", "editor", "missing")).toEqual({
      ok: false, status: 404, error: "not_found",
    });
    expect(await requireSite(as("site-viewer@shop.test"), "sitea", "viewer")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as("site-viewer@shop.test"), "sitea", "editor")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as("site-viewer@shop.test"), "sitea", "editor", "missing")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as("site-viewer@shop.test", `Bearer ${ADMIN}`), "sitea", "editor")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as("site-owner@shop.test"), "sitea", "owner")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as("site-owner@shop.test"), "siteb", "owner")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });

    expect(await requireSite(as(undefined, "Bearer wide-ro"), "siteb", "viewer")).toEqual(allow);
    expect(await requireSite(as(undefined, "Bearer wide-ro"), "siteb", "editor")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
    expect(await requireSite(as(undefined, "Bearer ada-ro"), "sitea", "viewer")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as(undefined, "Bearer ada-ro"), "sitez", "viewer")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite(as(undefined, "Bearer ada-ro"), "siteb", "viewer")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as(undefined, "Bearer ada-ro"), "sitea", "editor")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });
    expect(await requireSite(as(undefined, "Bearer bad-ro@not a site"), "sitea", "viewer")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
    expect(await requireSite(as(undefined, "Bearer bad-ro"), "sitea", "viewer")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
  });

  test("visible sites are grant keys for a member and the catalog for a wide caller", async () => {
    expect(await listVisibleSites(as("site-owner@shop.test"))).toEqual({
      ok: true, sites: ["sitea", "sitez"], scope: "sites",
    });
    expect(await listVisibleSites(as(undefined, "Bearer ada-ro"))).toEqual({
      ok: true, sites: ["sitea", "sitez"], scope: "sites",
    });
    expect(await listVisibleSites(as(undefined, `Bearer ${ADMIN}`))).toEqual({
      ok: true, sites: ["demo", "siteb"], scope: "deployment",
    });
    expect(await listVisibleSites(as(undefined, "Bearer wide-ro"))).toEqual({
      ok: true, sites: ["demo", "siteb"], scope: "deployment",
    });
    expect(await listVisibleSites(as(undefined, `Bearer ${DEMO}`))).toEqual({
      ok: true, sites: ["demo"], scope: "demo",
    });
    expect(await listVisibleSites(as())).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });

  test("admin boot defaults and the no-access shell", async () => {
    expect(await openAdmin(as(), undefined)).toEqual({ kind: "login" });
    expect(await openAdmin(as(undefined, `Bearer ${ADMIN}`), undefined)).toEqual({
      kind: "html",
      boot: { sites: ["demo", "siteb"], site: "demo", denied: false },
    });
    expect(await openAdmin(as(undefined, `Bearer ${ADMIN}`), "fresh")).toEqual({
      kind: "html",
      boot: { sites: ["demo", "fresh", "siteb"], site: "fresh", denied: false },
    });
    expect(await openAdmin(as("site-owner@shop.test"), undefined)).toEqual({
      kind: "html",
      boot: { sites: ["sitea", "sitez"], site: "sitea", denied: false },
    });
    expect(await openAdmin(as("site-owner@shop.test"), "siteb")).toEqual({
      kind: "html",
      boot: { sites: ["sitea", "sitez"], site: null, denied: true },
    });
    expect(await openAdmin(as("site-owner@shop.test"), "  ")).toEqual({
      kind: "html",
      boot: { sites: ["sitea", "sitez"], site: "sitea", denied: false },
    });
    expect(await openAdmin(as(undefined, `Bearer ${DEMO}`), "siteb")).toEqual({
      kind: "html",
      boot: { sites: ["demo"], site: null, denied: true },
    });
    expect(await openAdmin(as(undefined, `Bearer ${DEMO}`), undefined)).toEqual({
      kind: "html",
      boot: { sites: ["demo"], site: "demo", denied: false },
    });
  });

  test("deployment gate, admin token, and the pay-link cookie", async () => {
    expect(await requireDeployment(as())).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireDeployment(as(undefined, `Bearer ${DEMO}`))).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireDeployment(as(undefined, "Bearer wide-ro"))).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireDeployment(as(undefined, "Bearer ada-ro"))).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireDeployment(as("editor@prism.test"))).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireDeployment(as("viewer@prism.test"))).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireDeployment(as("owner@prism.test"))).toEqual({ ok: true });
    expect(await requireDeployment(as(undefined, `Bearer ${ADMIN}`))).toEqual({ ok: true });
    expect(await requireDeployment(as("site-owner@shop.test"))).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireDeployment(as("site-owner@shop.test", `Bearer ${ADMIN}`))).toEqual({ ok: true });

    expect(await requireAdminToken(as(undefined, `Bearer ${ADMIN}`))).toEqual({ ok: true });
    expect(await requireAdminToken(as(undefined, undefined, ADMIN))).toEqual({ ok: true });
    expect(await requireAdminToken(as("owner@prism.test"))).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(await requireAdminToken(as(undefined, `Bearer ${DEMO}`))).toEqual({ ok: false, status: 401, error: "unauthorized" });

    expect(await wideOwnerSession(as("owner@prism.test"))).toBe(true);
    expect(await wideOwnerSession(as(undefined, `Bearer ${ADMIN}`))).toBe(false);
    expect(await wideOwnerSession(as("site-owner@shop.test"))).toBe(false);
    expect(await wideOwnerSession(as("editor@prism.test"))).toBe(false);
  });

  test("seed inserts grants, ignores a later env edit, and the gate follows the rows", async () => {
    seedAccounts({
      allowlist: "ford@x.com:owner,ada@shop.com:owner@ada,ben@shop.com:editor@ada|ada-eu,bad@x.com:editor@not a site,legacy@x.com:nope",
      devEmail: "dev@local.test",
    });
    expect(db.prepare("SELECT role FROM accounts WHERE email = ?").get("ford@x.com")).toEqual({ role: "owner" });
    expect(db.prepare("SELECT role FROM accounts WHERE email = ?").get("legacy@x.com")).toEqual({ role: "editor" });
    expect(db.prepare("SELECT role FROM accounts WHERE email = ?").get("dev@local.test")).toEqual({ role: "owner" });
    expect(db.prepare("SELECT site, role FROM account_sites WHERE email = ? ORDER BY site").all("ada@shop.com")).toEqual([
      { site: "ada", role: "owner" },
    ]);
    expect(db.prepare("SELECT site, role FROM account_sites WHERE email = ? ORDER BY site").all("ben@shop.com")).toEqual([
      { site: "ada", role: "editor" },
      { site: "ada-eu", role: "editor" },
    ]);
    expect(db.prepare("SELECT email FROM accounts WHERE email = ?").get("bad@x.com")).toEqual(null);
    expect(db.prepare("SELECT site FROM account_sites WHERE email = ?").all("ford@x.com")).toEqual([]);
    expect(db.prepare("SELECT site FROM account_sites WHERE email = ?").all("dev@local.test")).toEqual([]);

    const ford = { req: headerCtx(`prism_session=${await makeSession("ford@x.com")}`) };
    const ada = { req: headerCtx(`prism_session=${await makeSession("ada@shop.com")}`) };
    const ben = { req: headerCtx(`prism_session=${await makeSession("ben@shop.com")}`) };
    const legacy = { req: headerCtx(`prism_session=${await makeSession("legacy@x.com")}`) };
    const dev = { req: headerCtx(`prism_session=${await makeSession("dev@local.test")}`) };
    const missing = { req: headerCtx(`prism_session=${await makeSession("bad@x.com")}`) };
    expect(await requireSite(ford, "anywhere", "owner")).toEqual({ ok: true, scope: "deployment", canRegisterSite: true });
    expect(await requireSite(ada, "ada", "owner")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(ada, "other", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(ben, "ada-eu", "editor")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(ben, "other", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(legacy, "anywhere", "editor")).toEqual({ ok: true, scope: "deployment", canRegisterSite: false });
    expect(await requireSite(dev, "anywhere", "owner")).toEqual({ ok: true, scope: "deployment", canRegisterSite: true });
    expect(await requireSite(missing, "ada", "viewer")).toEqual({ ok: false, status: 401, error: "unauthorized" });

    db.prepare("UPDATE account_sites SET role = 'viewer' WHERE email = ? AND site = ?").run("ada@shop.com", "ada");
    seedAccounts({ allowlist: "ada@shop.com:owner@ada", devEmail: null });
    expect(db.prepare("SELECT role FROM account_sites WHERE email = ? AND site = ?").get("ada@shop.com", "ada")).toEqual({
      role: "viewer",
    });
    const adaAfter = { req: headerCtx(`prism_session=${await makeSession("ada@shop.com")}`) };
    expect(await requireSite(adaAfter, "ada", "owner")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(await requireSite(adaAfter, "ada", "viewer")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
  });

  test("a dev email that already has grants stays scoped", async () => {
    seedAccounts({ allowlist: "dev2@local.test:viewer@ada", devEmail: "dev2@local.test" });
    const dev2 = { req: headerCtx(`prism_session=${await makeSession("dev2@local.test")}`) };
    expect(await requireSite(dev2, "ada", "viewer")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(dev2, "other", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(db.prepare("SELECT role FROM accounts WHERE email = ?").get("dev2@local.test")).toEqual({ role: "viewer" });
  });

  test("membership upsert scopes a wide account and the last delete removes the login", async () => {
    expect(upsertMembership({ email: "nope", site: "ok", role: "owner" })).toEqual({ ok: false, status: 400, error: "invalid" });
    expect(upsertMembership({ email: "a@b.co", site: "bad site", role: "owner" })).toEqual({ ok: false, status: 400, error: "invalid" });
    expect(upsertMembership({ email: "a@b.co", site: "ok", role: "admin" })).toEqual({ ok: false, status: 400, error: "invalid" });

    expect(upsertMembership({ email: "New@Shop.test", site: "ada", role: "owner" })).toEqual({
      ok: true, email: "new@shop.test", site: "ada", role: "owner", scope: "sites",
    });
    expect(db.prepare("SELECT role FROM accounts WHERE email = ?").get("new@shop.test")).toEqual({ role: "editor" });
    const created = { req: headerCtx(`prism_session=${await makeSession("new@shop.test")}`) };
    expect(await requireSite(created, "ada", "owner")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });

    db.prepare("INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?)").run("wide-then@shop.test", "owner", 1);
    const wideCookie = `prism_session=${await makeSession("wide-then@shop.test")}`;
    expect(await requireSite({ req: headerCtx(wideCookie) }, "other", "owner")).toEqual({
      ok: true, scope: "deployment", canRegisterSite: true,
    });
    expect(upsertMembership({ email: "wide-then@shop.test", site: "only", role: "viewer" })).toEqual({
      ok: true, email: "wide-then@shop.test", site: "only", role: "viewer", scope: "sites",
    });
    expect(await requireSite({ req: headerCtx(wideCookie) }, "only", "viewer")).toEqual({
      ok: true, scope: "sites", canRegisterSite: false,
    });
    expect(await requireSite({ req: headerCtx(wideCookie) }, "other", "viewer")).toEqual({
      ok: false, status: 403, error: "forbidden",
    });

    expect(upsertMembership({ email: "two@shop.test", site: "sitea", role: "editor" })).toEqual({
      ok: true, email: "two@shop.test", site: "sitea", role: "editor", scope: "sites",
    });
    expect(upsertMembership({ email: "two@shop.test", site: "siteb", role: "viewer" })).toEqual({
      ok: true, email: "two@shop.test", site: "siteb", role: "viewer", scope: "sites",
    });
    expect(deleteMembership({ email: "two@shop.test", site: "siteb" })).toEqual({
      ok: true, removed: true, accountDeleted: false,
    });
    const two = { req: headerCtx(`prism_session=${await makeSession("two@shop.test")}`) };
    expect(await requireSite(two, "sitea", "editor")).toEqual({ ok: true, scope: "sites", canRegisterSite: false });
    expect(await requireSite(two, "siteb", "viewer")).toEqual({ ok: false, status: 403, error: "forbidden" });

    expect(deleteMembership({ email: "wide-then@shop.test", site: "only" })).toEqual({
      ok: true, removed: true, accountDeleted: true,
    });
    expect(await requireSite({ req: headerCtx(wideCookie) }, "only", "viewer")).toEqual({
      ok: false, status: 401, error: "unauthorized",
    });
    expect(db.prepare("SELECT email FROM accounts WHERE email = ?").get("wide-then@shop.test")).toEqual(null);

    db.prepare("INSERT INTO accounts (email, role, created_at) VALUES (?, ?, ?)").run("stay@shop.test", "owner", 1);
    expect(deleteMembership({ email: "stay@shop.test", site: "missing" })).toEqual({
      ok: true, removed: false, accountDeleted: false,
    });
    const stay = { req: headerCtx(`prism_session=${await makeSession("stay@shop.test")}`) };
    expect(await requireSite(stay, "anywhere", "owner")).toEqual({ ok: true, scope: "deployment", canRegisterSite: true });
  });
}

function headerCtx(cookie?: string, authorization?: string, token?: string) {
  return {
    header(name: string) {
      const key = name.toLowerCase();
      if (key === "cookie") return cookie;
      if (key === "authorization") return authorization;
      return undefined;
    },
    query(name: string) {
      if (name === "token") return token;
      return undefined;
    },
  };
}
