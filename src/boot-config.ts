// Boot-time env/config checks that do not open the database.
// A config error must fail boot with live untouched; it is never a reason to quarantine.

const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLANS = new Set(["shadow", "growth", "pro", "agency", "selfhost"]);

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

export function validateBootConfig(env: NodeJS.ProcessEnv): string | undefined {
  try {
    parseReadonlyTokens(env.READONLY_TOKENS ?? "");
  } catch (err) {
    return err instanceof Error ? err.message : "duplicate readonly token";
  }
  const plan = (env.PRISM_PLAN ?? "").trim();
  if (plan !== "" && !PLANS.has(plan)) return `PRISM_PLAN is not a known plan: ${plan}`;
  return undefined;
}
