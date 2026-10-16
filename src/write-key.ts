import { db } from "./db";

const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DENY = { ok: false as const, status: 401 as const, error: "bad write key" as const };

export type WriteKeyDecision =
  | { ok: true; site: string; via: "site" | "legacy" }
  | { ok: false; status: 401; error: "bad write key" };

export type WriteKeyView = {
  site: string;
  writeKey: string;
  snippet: string;
};

const selectByKey = db.prepare("SELECT site FROM sites WHERE write_key = ?");
const selectBySite = db.prepare("SELECT write_key FROM sites WHERE site = ?");
const selectSite = db.prepare("SELECT site FROM sites WHERE site = ?");
const listRegistered = db.prepare("SELECT site, write_key FROM sites");
const fillKey = db.prepare(
  "UPDATE sites SET write_key = ? WHERE site = ? AND (write_key IS NULL OR write_key = '')",
);
const setKey = db.prepare("UPDATE sites SET write_key = ? WHERE site = ?");

export function newWriteKey(): string {
  return "wk_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export function issueSiteWriteKeys(): { issued: number } {
  let issued = 0;
  db.transaction(() => {
    const rows = listRegistered.all() as { site: string; write_key: string | null }[];
    for (const row of rows) {
      if (!SITE_RE.test(row.site) || row.write_key) continue;
      fillKey.run(newWriteKey(), row.site);
      issued++;
    }
  })();
  return { issued };
}

export function siteWriteKey(site: string): string | null {
  const row = selectBySite.get(site) as { write_key: string | null } | null;
  return row?.write_key ?? null;
}

export function legacyWriteKeyOpen(now = Date.now()): boolean {
  const raw = process.env.SITE_WRITE_KEY_GRACE_UNTIL;
  if (raw === undefined || raw === "") return true;
  const until = Number(raw);
  return Number.isFinite(until) && now < until;
}

export function requireWriteKey(
  presented: string | undefined,
  claimedSite: string,
  now = Date.now(),
): WriteKeyDecision {
  if (!presented || !SITE_RE.test(claimedSite)) return DENY;
  const shared = process.env.SITE_WRITE_KEY;
  if (shared && presented === shared) {
    if (!legacyWriteKeyOpen(now)) return DENY;
    if (!selectSite.get(claimedSite)) return DENY;
    console.warn(
      `legacy SITE_WRITE_KEY accepted for site ${claimedSite}; install that site's write key`,
    );
    return { ok: true, site: claimedSite, via: "legacy" };
  }
  const row = selectByKey.get(presented) as { site: string } | null;
  if (!row || row.site !== claimedSite) return DENY;
  return { ok: true, site: row.site, via: "site" };
}

export function writeKeySnippet(site: string, writeKey: string, host = "https://YOUR_HOST"): string {
  return `<script defer src="${host}/snippet.js" data-site="${site}" data-key="${writeKey}" data-selectors="#hero,#grid"></script>`;
}

function viewFor(site: string, writeKey: string): WriteKeyView {
  return { site, writeKey, snippet: writeKeySnippet(site, writeKey) };
}

export function readWriteKey(site: string): WriteKeyView | { ok: false; error: "not_found" } {
  const key = siteWriteKey(site);
  if (!key) return { ok: false, error: "not_found" };
  return viewFor(site, key);
}

export function rotateWriteKey(site: string): WriteKeyView | { ok: false; error: "not_found" } {
  if (!selectSite.get(site)) return { ok: false, error: "not_found" };
  const key = newWriteKey();
  setKey.run(key, site);
  return viewFor(site, key);
}

export function injectDemoWriteKey(html: string, writeKey: string): string {
  return html.replace(
    /(<script defer src="\/snippet\.js" data-site="demo")(?![^>]*\bdata-key=)/,
    `$1 data-key="${writeKey}"`,
  );
}
