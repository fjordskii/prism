// First-party counts for the marketing site. Rows store an event name, a UTC
// day, UTM fields, and a referrer host. No cookie, no visitor id, no IP.

export const GROWTH_EVENTS = [
  "landing_view",
  "pilot_cta",
  "pilot_view",
  "pilot_inquiry",
  "snippet_copy",
] as const;

export type GrowthEvent = (typeof GROWTH_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(GROWTH_EVENTS);

export const GROWTH_BODY_MAX = 1024;
export const UTM_MAX = 80;
export const REFERRER_MAX = 2048;

const RANGE_DAYS = 90;
const DAY_MS = 86_400_000;

export type Attribution = {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
};

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function isUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Inclusive UTC dates. Omitted bounds cover the last 90 days through today.
export function growthRange(
  from: string | undefined,
  to: string | undefined,
  now = Date.now(),
): { ok: true; from: string; to: string } | { ok: false } {
  const today = utcDay(now);
  const startDefault = utcDay(now - (RANGE_DAYS - 1) * DAY_MS);
  const start = (from ?? "").trim() || startDefault;
  const end = (to ?? "").trim() || today;
  if (!isUtcDay(start) || !isUtcDay(end) || start > end) return { ok: false };
  return { ok: true, from: start, to: end };
}

export function cleanUtm(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f<>"'`\\]/g, "").trim().slice(0, UTM_MAX);
}

// Hostname only. IP addresses are dropped so a referrer cannot smuggle one into the row.
export function referrerHost(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw || raw.length > REFERRER_MAX) return "";
  let host = "";
  try {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? new URL(raw) : new URL(`http://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  if (!host || host.length > 253) return "";
  if (host.includes(":")) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return "";
  return host;
}

export function attributionFrom(raw: unknown, refererHeader?: string | null): Attribution {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let fromReferer = { source: "", medium: "", campaign: "" };
  if (typeof refererHeader === "string" && refererHeader.length > 0 && refererHeader.length <= REFERRER_MAX) {
    try {
      const url = new URL(refererHeader);
      fromReferer = {
        source: cleanUtm(url.searchParams.get("utm_source")),
        medium: cleanUtm(url.searchParams.get("utm_medium")),
        campaign: cleanUtm(url.searchParams.get("utm_campaign")),
      };
    } catch {
      fromReferer = { source: "", medium: "", campaign: "" };
    }
  }
  return {
    source: cleanUtm(body.utm_source) || fromReferer.source,
    medium: cleanUtm(body.utm_medium) || fromReferer.medium,
    campaign: cleanUtm(body.utm_campaign) || fromReferer.campaign,
    referrerHost: referrerHost(body.referrer),
  };
}

export function parseGrowthBody(
  raw: unknown,
  refererHeader?: string | null,
): { ok: true; event: GrowthEvent; attribution: Attribution } | { ok: false } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const body = raw as Record<string, unknown>;
  const event = typeof body.event === "string" ? body.event.trim() : "";
  if (!EVENT_SET.has(event)) return { ok: false };
  return { ok: true, event: event as GrowthEvent, attribution: attributionFrom(body, refererHeader) };
}

export type GrowthCountRow = {
  event: string;
  day: string;
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
  count: number;
};

export type GrowthUtm = {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
  count: number;
};

export type GrowthReport = {
  from: string;
  to: string;
  days: {
    day: string;
    events: Record<string, { count: number; utm: GrowthUtm[] }>;
  }[];
};

export function growthReport(rows: GrowthCountRow[], from: string, to: string): GrowthReport {
  const byDay = new Map<string, GrowthReport["days"][number]>();
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    let day = byDay.get(row.day);
    if (!day) {
      day = { day: row.day, events: {} };
      byDay.set(row.day, day);
    }
    let bucket = day.events[row.event];
    if (!bucket) {
      bucket = { count: 0, utm: [] };
      day.events[row.event] = bucket;
    }
    bucket.count += row.count;
    bucket.utm.push({
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      referrerHost: row.referrerHost,
      count: row.count,
    });
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const day of days) {
    for (const bucket of Object.values(day.events)) {
      bucket.utm.sort((a, b) => b.count - a.count || a.campaign.localeCompare(b.campaign) || a.source.localeCompare(b.source) || a.referrerHost.localeCompare(b.referrerHost));
    }
  }
  return { from, to, days };
}

// Inline on the marketing pages. Failures stay inside this tag.
export function growthClientScript(opts: { view: "landing_view" | "pilot_view"; trackClicks?: boolean; fillForm?: boolean }): string {
  const clicks = opts.trackClicks ? "true" : "false";
  const fill = opts.fillForm ? "true" : "false";
  return `<script>
(function () {
  var trackClicks = ${clicks};
  var fillForm = ${fill};
  function send(event) {
    try {
      var params = new URLSearchParams(location.search);
      var body = JSON.stringify({
        event: event,
        utm_source: params.get("utm_source") || "",
        utm_medium: params.get("utm_medium") || "",
        utm_campaign: params.get("utm_campaign") || "",
        referrer: document.referrer || ""
      });
      var blob = new Blob([body], { type: "application/json" });
      if (!(navigator.sendBeacon && navigator.sendBeacon("/api/growth", blob))) {
        fetch("/api/growth", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (err) {}
  }
  if (fillForm) {
    try {
      var params = new URLSearchParams(location.search);
      var fields = {
        utm_source: params.get("utm_source") || "",
        utm_medium: params.get("utm_medium") || "",
        utm_campaign: params.get("utm_campaign") || "",
        referrer: document.referrer || ""
      };
      Object.keys(fields).forEach(function (name) {
        var input = document.querySelector('form input[name="' + name + '"]');
        if (input) input.value = fields[name];
      });
    } catch (err) {}
  }
  send(${JSON.stringify(opts.view)});
  if (trackClicks) {
    document.addEventListener("click", function (ev) {
      var node = ev.target;
      if (!node || !node.closest) return;
      var link = node.closest("#pricing a");
      if (link) {
        var href = link.getAttribute("href") || "";
        if (href === "/pilot" || href.indexOf("/pilot?") === 0 || href.indexOf("/pilot#") === 0) send("pilot_cta");
      }
      if (node.closest("#copySnippet")) send("snippet_copy");
    }, true);
  }
})();
</script>`;
}
