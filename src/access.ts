import { db } from "./db";
import { DEV_EMAIL, SESSION_COOKIE, oauthEnabled, sessionEmail, type Role } from "./auth";
import { issueSiteWriteKeys } from "./write-key";

export {
  injectDemoWriteKey, readWriteKey, requireWriteKey, rotateWriteKey, siteWriteKey,
  writeKeySnippet, type WriteKeyDecision, type WriteKeyView,
} from "./write-key";

export const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export type AllowEntry = {
  email: string;
  role: Role;
  sites: readonly string[] | null;
};

function exactRole(raw: string): Role | null {
  if (raw === "owner" || raw === "editor" || raw === "viewer") return raw;
  return null;
}

function roleAtLeast(have: Role, min: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[min];
}

export function parseAllowlist(raw: string): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.indexOf(":");
    if (colon === -1) {
      out.push({ email: entry.toLowerCase(), role: "editor", sites: null });
      continue;
    }
    const email = entry.slice(0, colon).trim().toLowerCase();
    if (!email) continue;
    const rest = entry.slice(colon + 1);
    const at = rest.indexOf("@");
    if (at === -1) {
      out.push({ email, role: exactRole(rest.trim()) ?? "editor", sites: null });
      continue;
    }
    const role = exactRole(rest.slice(0, at).trim()) ?? "editor";
    const sites = rest.slice(at + 1).split("|").map((site) => site.trim());
    if (sites.length === 0 || sites.some((site) => !SITE_RE.test(site))) continue;
    out.push({ email, role, sites });
  }
  return out;
}

export function parseReadonlyTokens(raw: string): ReadonlyMap<string, readonly string[] | null> {
  const out = new Map<string, readonly string[] | null>();
  for (const entry of raw.split(",")) {
    if (entry === "") continue;
    const at = entry.indexOf("@");
    if (at === -1) {
      if (out.has(entry)) throw new Error("duplicate readonly token");
      out.set(entry, null);
      continue;
    }
    const secret = entry.slice(0, at);
    const sites = entry.slice(at + 1).split("|").map((site) => site.trim());
    if (secret === "" || sites.length === 0 || sites.some((site) => !SITE_RE.test(site))) continue;
    if (out.has(secret)) throw new Error("duplicate readonly token");
    out.set(secret, sites);
  }
  return out;
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DEMO_TOKEN = process.env.DEMO_TOKEN || "demo-panel-2026";
const readonlyTokens = parseReadonlyTokens(process.env.READONLY_TOKENS ?? "");

type AccountRecord =
  | { kind: "missing" }
  | { kind: "deployment"; role: Role }
  | { kind: "sites"; grants: ReadonlyMap<string, Role> };

const accountJoin = db.prepare(
  `SELECT a.role AS account_role, s.site AS site, s.role AS site_role
   FROM accounts a LEFT JOIN account_sites s ON s.email = a.email
   WHERE a.email = ?`
);
const insAccount = db.prepare("INSERT OR IGNORE INTO accounts (email, role, created_at) VALUES (?, ?, ?)");
const insGrant = db.prepare("INSERT OR IGNORE INTO account_sites (email, site, role) VALUES (?, ?, ?)");
const upsertGrant = db.prepare(
  `INSERT INTO account_sites (email, site, role) VALUES (?, ?, ?)
   ON CONFLICT(email, site) DO UPDATE SET role = excluded.role`
);
const delGrant = db.prepare("DELETE FROM account_sites WHERE email = ? AND site = ?");
const countGrants = db.prepare("SELECT COUNT(*) AS n FROM account_sites WHERE email = ?");
const delAccount = db.prepare("DELETE FROM accounts WHERE email = ?");

function readAccount(email: string): AccountRecord {
  const rows = accountJoin.all(email.toLowerCase()) as {
    account_role: string;
    site: string | null;
    site_role: string | null;
  }[];
  if (rows.length === 0) return { kind: "missing" };
  const membership = rows.filter((row) => row.site !== null);
  if (membership.length === 0) {
    const role = exactRole(rows[0]!.account_role);
    return role ? { kind: "deployment", role } : { kind: "missing" };
  }
  const grants = new Map<string, Role>();
  for (const row of membership) {
    const role = exactRole(row.site_role ?? "");
    if (role && row.site) grants.set(row.site, role);
  }
  return { kind: "sites", grants };
}

export function seedAccounts(input?: { allowlist?: string; devEmail?: string | null }): void {
  const allowlist = input?.allowlist ?? process.env.GOOGLE_ALLOWED_EMAILS ?? "";
  const devEmail = input && "devEmail" in input ? input.devEmail ?? null : DEV_EMAIL;
  const now = Date.now();
  db.transaction(() => {
    for (const entry of parseAllowlist(allowlist)) {
      insAccount.run(entry.email, entry.role, now);
      for (const site of entry.sites ?? []) insGrant.run(entry.email, site, entry.role);
    }
    if (devEmail) insAccount.run(devEmail.toLowerCase(), "owner", now);
  })();
}

export type MembershipWrite =
  | { ok: true; email: string; site: string; role: Role; scope: "sites" }
  | { ok: false; status: 400; error: "invalid" };

export type MembershipDelete =
  | { ok: true; removed: boolean; accountDeleted: boolean }
  | { ok: false; status: 400; error: "invalid" };

function parseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320 || /\s/.test(email) || !email.includes("@")) return null;
  return email;
}

function parseSite(raw: unknown): string | null {
  if (typeof raw !== "string" || !SITE_RE.test(raw.trim())) return null;
  return raw.trim();
}

function bodyOf(input: unknown): { email?: unknown; site?: unknown; role?: unknown } {
  if (!input || typeof input !== "object") return {};
  return input as { email?: unknown; site?: unknown; role?: unknown };
}

export function upsertMembership(input: unknown): MembershipWrite {
  const body = bodyOf(input);
  const email = parseEmail(body.email);
  const site = parseSite(body.site);
  const role = typeof body.role === "string" ? exactRole(body.role.trim()) : null;
  if (!email || !site || !role) return { ok: false, status: 400, error: "invalid" };
  const now = Date.now();
  db.transaction(() => {
    insAccount.run(email, "editor", now);
    upsertGrant.run(email, site, role);
  })();
  return { ok: true, email, site, role, scope: "sites" };
}

export function deleteMembership(input: unknown): MembershipDelete {
  const body = bodyOf(input);
  const email = parseEmail(body.email);
  const site = parseSite(body.site);
  if (!email || !site) return { ok: false, status: 400, error: "invalid" };
  let removed = false;
  let accountDeleted = false;
  db.transaction(() => {
    if (delGrant.run(email, site).changes === 0) return;
    removed = true;
    const left = countGrants.get(email) as { n: number };
    if (left.n === 0) {
      delAccount.run(email);
      accountDeleted = true;
    }
  })();
  return { ok: true, removed, accountDeleted };
}

type Access =
  | { kind: "deployment"; role: Role; via: "account" | "admin" | "open" | "readonly" }
  | { kind: "sites"; grants: ReadonlyMap<string, Role>; via: "account" | "readonly" }
  | { kind: "demo" }
  | { kind: "none" };

type Materials = {
  session: Access | null;
  token: Access;
  open: boolean;
};

export type AccessCtx = {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
};

export type SiteDecision =
  | { ok: true; scope: "deployment" | "sites" | "demo"; canRegisterSite: boolean }
  | { ok: false; status: 401; error: "unauthorized" }
  | { ok: false; status: 403; error: "forbidden" }
  | { ok: false; status: 404; error: "not_found" };

export type DeployDecision =
  | { ok: true }
  | { ok: false; status: 401; error: "unauthorized" }
  | { ok: false; status: 403; error: "forbidden" };

export type CatalogResult =
  | { ok: true; sites: readonly string[]; scope: "deployment" | "sites" | "demo" }
  | { ok: false; status: 401; error: "unauthorized" };

export type DashboardBoot = {
  sites: readonly string[];
  site: string | null;
  denied: boolean;
};

export type AdminPage =
  | { kind: "login" }
  | { kind: "unauthorized" }
  | { kind: "html"; boot: DashboardBoot };

const materialCache = new WeakMap<AccessCtx, Promise<Materials>>();

function requestToken(c: AccessCtx): string | undefined {
  const header = c.req.header("authorization");
  if (header !== undefined) return header.replace(/^Bearer /, "");
  return c.req.query("token");
}

function readCookie(c: AccessCtx): string | undefined {
  const raw = c.req.header("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

function tokenAccess(tok: string | undefined): Access {
  if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return { kind: "deployment", role: "owner", via: "admin" };
  if (tok && tok === DEMO_TOKEN) return { kind: "demo" };
  if (tok !== undefined && readonlyTokens.has(tok)) {
    const sites = readonlyTokens.get(tok) ?? null;
    if (sites === null) return { kind: "deployment", role: "viewer", via: "readonly" };
    const grants = new Map<string, Role>();
    for (const site of sites) grants.set(site, "viewer");
    return { kind: "sites", grants, via: "readonly" };
  }
  return { kind: "none" };
}

function sessionAccess(email: string | null): Access | null {
  if (!email) return null;
  const account = readAccount(email);
  if (account.kind === "missing") return null;
  if (account.kind === "deployment") return { kind: "deployment", role: account.role, via: "account" };
  return { kind: "sites", grants: account.grants, via: "account" };
}

async function materials(c: AccessCtx): Promise<Materials> {
  const cached = materialCache.get(c);
  if (cached) return cached;
  const pending = (async () => {
    const email = await sessionEmail(readCookie(c));
    return {
      session: sessionAccess(email),
      token: tokenAccess(requestToken(c)),
      open: !ADMIN_TOKEN && !oauthEnabled,
    };
  })();
  materialCache.set(c, pending);
  return pending;
}

function accessForSite(m: Materials): Access {
  if (m.session) return m.session;
  if (m.open) return { kind: "deployment", role: "owner", via: "open" };
  return m.token;
}

function accessForDeployment(m: Materials): Access {
  if (m.token.kind === "deployment" && m.token.via === "admin") return m.token;
  if (m.session?.kind === "deployment" && m.session.role === "owner") return m.session;
  if (m.open) return { kind: "deployment", role: "owner", via: "open" };
  if (m.session) return m.session;
  return m.token;
}

function canMint(access: Access): boolean {
  return access.kind === "deployment"
    && access.role === "owner"
    && (access.via === "account" || access.via === "admin" || access.via === "open");
}

function decide(access: Access, site: string, minRole: Role, miss: "deny" | "missing"): SiteDecision {
  if (access.kind === "none") return { ok: false, status: 401, error: "unauthorized" };

  if (access.kind === "demo") {
    if (site === "demo" && roleAtLeast("editor", minRole)) {
      return { ok: true, scope: "demo", canRegisterSite: false };
    }
    if (minRole === "owner") return { ok: false, status: 403, error: "forbidden" };
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (access.kind === "deployment") {
    if (roleAtLeast(access.role, minRole)) {
      return { ok: true, scope: "deployment", canRegisterSite: canMint(access) };
    }
    if (minRole === "owner") return { ok: false, status: 403, error: "forbidden" };
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const grant = access.grants.get(site);
  if (grant && roleAtLeast(grant, minRole)) {
    return { ok: true, scope: "sites", canRegisterSite: false };
  }
  if (!grant && miss === "missing") return { ok: false, status: 404, error: "not_found" };
  return { ok: false, status: 403, error: "forbidden" };
}

export async function requireSite(
  c: AccessCtx,
  site: string,
  minRole: Role,
  miss: "deny" | "missing" = "deny",
): Promise<SiteDecision> {
  return decide(accessForSite(await materials(c)), site, minRole, miss);
}

export async function requireDeployment(c: AccessCtx): Promise<DeployDecision> {
  const access = accessForDeployment(await materials(c));
  if (
    access.kind === "deployment"
    && access.role === "owner"
    && (access.via === "account" || access.via === "admin" || access.via === "open")
  ) {
    return { ok: true };
  }
  if (access.kind === "sites") return { ok: false, status: 403, error: "forbidden" };
  return { ok: false, status: 401, error: "unauthorized" };
}

export async function requireAdminToken(c: AccessCtx): Promise<DeployDecision> {
  const tok = requestToken(c);
  if (ADMIN_TOKEN && tok === ADMIN_TOKEN) return { ok: true };
  return { ok: false, status: 401, error: "unauthorized" };
}

export async function wideOwnerSession(c: AccessCtx): Promise<boolean> {
  const m = await materials(c);
  return m.session?.kind === "deployment" && m.session.role === "owner";
}

function catalogSites(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT site FROM variants UNION SELECT DISTINCT site FROM events UNION SELECT DISTINCT site FROM visitors"
  ).all() as { site: string }[];
  return rows.map((row) => row.site).sort();
}

export async function listVisibleSites(c: AccessCtx): Promise<CatalogResult> {
  const access = accessForSite(await materials(c));
  if (access.kind === "none") return { ok: false, status: 401, error: "unauthorized" };
  if (access.kind === "sites") {
    return { ok: true, sites: [...access.grants.keys()].sort(), scope: "sites" };
  }
  const catalog = catalogSites();
  if (access.kind === "demo") {
    return { ok: true, sites: catalog.filter((site) => site === "demo"), scope: "demo" };
  }
  return { ok: true, sites: catalog, scope: "deployment" };
}

export async function openAdmin(c: AccessCtx, rawSite: string | undefined): Promise<AdminPage> {
  const listed = await listVisibleSites(c);
  if (!listed.ok) return oauthEnabled ? { kind: "login" } : { kind: "unauthorized" };
  const requested = (rawSite ?? "").trim();
  if (!requested) {
    if (listed.scope === "sites") {
      return { kind: "html", boot: { sites: listed.sites, site: listed.sites[0] ?? null, denied: false } };
    }
    return { kind: "html", boot: { sites: listed.sites, site: "demo", denied: false } };
  }
  const gate = await requireSite(c, requested, "viewer");
  if (gate.ok) {
    const sites = listed.sites.includes(requested) ? listed.sites : [...listed.sites, requested].sort();
    return { kind: "html", boot: { sites, site: requested, denied: false } };
  }
  return { kind: "html", boot: { sites: listed.sites, site: null, denied: true } };
}

export const SITE_GATES = [
  { id: "sites.list", method: "GET", path: "/api/sites", call: "listVisibleSites" },
  { id: "variants.list", method: "GET", path: "/api/variants", call: "requireSite", minRole: "viewer" },
  { id: "variants.create", method: "POST", path: "/api/variants", call: "requireSite", minRole: "editor", then: ["applyCap"] },
  { id: "variants.toggle", method: "POST", path: "/api/variants/:id/toggle", call: "requireSite", minRole: "editor", miss: "missing" },
  { id: "variants.delete", method: "DELETE", path: "/api/variants/:id", call: "requireSite", minRole: "editor", miss: "missing" },
  { id: "stats", method: "GET", path: "/api/stats", call: "requireSite", minRole: "viewer" },
  { id: "export", method: "GET", path: "/api/export", call: "requireSite", minRole: "viewer" },
  { id: "visitors.read", method: "GET", path: "/api/visitors/:id", call: "requireSite", minRole: "viewer" },
  { id: "visitors.erase", method: "DELETE", path: "/api/visitors/:id", call: "requireSite", minRole: "editor" },
  { id: "holdout", method: "POST", path: "/api/sites/:site/holdout", call: "requireSite", minRole: "owner", then: ["applyCap", "saveHoldout"] },
  { id: "lift", method: "GET", path: "/api/sites/:site/lift-report", call: "requireSite", minRole: "owner" },
  { id: "decide", method: "POST", path: "/api/decide", call: "requireSite", minRole: "viewer", denial: "attach" },
  { id: "admin", method: "GET", path: "/admin", call: "openAdmin" },
  { id: "growth.read", method: "GET", path: "/api/growth", call: "requireDeployment" },
  { id: "pilot.inquiries", method: "GET", path: "/api/pilot/inquiries", call: "requireDeployment" },
  { id: "pilot.billing", method: "GET", path: "/api/pilot/billing-status", call: "requireDeployment" },
  { id: "architecture", method: "GET", path: "/architecture", call: "requireDeployment" },
  { id: "plan", method: "POST", path: "/api/sites/:site/plan", call: "requireDeployment" },
  { id: "membership.put", method: "PUT", path: "/api/account-sites", call: "requireAdminToken" },
  { id: "membership.delete", method: "DELETE", path: "/api/account-sites", call: "requireAdminToken" },
  { id: "identify", method: "POST", path: "/api/identify", call: "requireWriteKey" },
  { id: "events", method: "POST", path: "/api/events", call: "requireWriteKey" },
  { id: "writeKey.read", method: "GET", path: "/api/sites/:site/write-key", call: "requireSite", minRole: "owner", then: ["applyCap"] },
  { id: "writeKey.rotate", method: "POST", path: "/api/sites/:site/write-key", call: "requireSite", minRole: "owner", then: ["applyCap"] },
] as const;

seedAccounts();
issueSiteWriteKeys();
