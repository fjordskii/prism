// Google OAuth for human access to /admin, /architecture, and the token-gated APIs.
// Agents and operators keep Bearer tokens — OAuth covers browsers, not machines.
// Active only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set; otherwise the
// existing token behavior is unchanged. DEV_AUTH_EMAIL is a local-only bypass that
// logs in without Google (mirrors the ADMIN_TOKEN-unset open mode for development).
import { sign, verify } from "hono/jwt";
import { db } from "./db";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const oauthEnabled = Boolean(CLIENT_ID && CLIENT_SECRET);
export const DEV_EMAIL = process.env.DEV_AUTH_EMAIL ?? null;

export type Role = "owner" | "editor" | "viewer";

// Session signing secret: explicit SESSION_SECRET, else the admin token. Rotating
// either invalidates all sessions — that is the revocation story for signed cookies.
const SECRET = process.env.SESSION_SECRET ?? process.env.ADMIN_TOKEN ?? "prism-dev-secret";

// ---------- accounts ----------
// Bootstrap: GOOGLE_ALLOWED_EMAILS="alice@x.com:owner,bob@x.com" (role optional,
// default editor). A deployment with OAuth on and zero accounts locks everyone out.
const upsertAccount = db.prepare(
  "INSERT OR IGNORE INTO accounts (email, role, created_at) VALUES (?, ?, ?)"
);
for (const entry of (process.env.GOOGLE_ALLOWED_EMAILS ?? "").split(",").filter(Boolean)) {
  const [email, role] = entry.split(":");
  if (!email) continue;
  upsertAccount.run(email.trim().toLowerCase(), role === "owner" || role === "viewer" ? role : "editor", Date.now());
}
if (DEV_EMAIL) upsertAccount.run(DEV_EMAIL.toLowerCase(), "owner", Date.now());

const getAccount = db.prepare("SELECT role FROM accounts WHERE email = ?");
export function accountRole(email: string): Role | null {
  const row = getAccount.get(email.toLowerCase()) as { role: Role } | null;
  return row?.role ?? null;
}

// ---------- session cookie (HMAC-signed JWT, 7 days) ----------
export const SESSION_COOKIE = "prism_session";

export function makeSession(email: string): Promise<string> {
  return sign({ email: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + 7 * 86400 }, SECRET);
}

export async function sessionEmail(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const payload = await verify(token, SECRET, "HS256");
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// ---------- Google OIDC handshake ----------
const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlDecode = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

export function googleAuthUrl(redirectUri: string, state: string, nonce: string): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  }).catch(() => null);
  if (!r?.ok) return null;
  const body = (await r.json().catch(() => null)) as { id_token?: string } | null;
  return body?.id_token ?? null;
}

type Jwk = { kty: string; kid: string; n: string; e: string };

// JWKS cached in memory for an hour; Google rotates rarely and kid-miss refetches once.
let jwksCache: { keys: Jwk[]; at: number } | null = null;
async function getJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const body = (await r.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

// Full RS256 id_token verification: signature against Google's JWKS, then iss/aud/exp/
// nonce/email_verified claims. `jwks` is injectable so tests can sign with a local key.
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  nonce: string,
  jwks?: Jwk[]
): Promise<{ email: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { kid?: string; alg?: string }, payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(h));
    payload = JSON.parse(b64urlDecode(p));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const keys = jwks ?? (await getJwks());
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s).buffer as ArrayBuffer,
    new TextEncoder().encode(h + "." + p)
  );
  if (!ok) return null;
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
  if (payload.aud !== clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  if (payload.nonce !== nonce) return null;
  if (payload.email_verified !== true || typeof payload.email !== "string") return null;
  return { email: payload.email.toLowerCase() };
}

// ---------- login page ----------
export function loginPage(error?: string): string {
  const google = oauthEnabled
    ? `<p><a href="/auth/google" style="display:inline-block;border:1px solid #ccc;border-radius:6px;padding:10px 18px;text-decoration:none;color:#1a1a1a">Sign in with Google</a></p>`
    : `<p style="color:#777">Google sign-in is not configured on this deployment (GOOGLE_CLIENT_ID/SECRET unset).</p>`;
  const dev = DEV_EMAIL
    ? `<p style="margin-top:24px;color:#b00">Dev mode: <a href="/auth/dev-login">sign in as ${DEV_EMAIL}</a> (DEV_AUTH_EMAIL is set — do not set it in production).</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in: Prism</title>
<style>body{font:15px/1.7 -apple-system,system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#1a1a1a}h1{font-size:22px}code{background:#f0f0ec;padding:1px 5px;border-radius:4px}</style></head>
<body><h1>Sign in to Prism</h1>
${error ? `<p style="color:#b00">${error}</p>` : ""}
${google}
<p style="color:#777">Agents and scripts keep using <code>Authorization: Bearer</code> tokens; nothing about the API auth changes.</p>
${dev}
</body></html>`;
}
