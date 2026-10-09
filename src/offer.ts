export const pilotCopy = {
  button: "Book a pilot",
  heading: "Try Prism on your Shopify store",
  body: "We install Prism on your store and set up 3 to 5 versions of your pages for customer groups you already have, like first-time visitors or repeat buyers. A share of visitors keeps seeing your normal site, so you can compare against them. Tell us about your store and we'll reply with next steps.",
  submit: "Send",
  emailLine: "Prefer email? Write to hello@sundaymorning.software.",
  mailto: "mailto:hello@sundaymorning.software?subject=Prism%20pilot",
  thanks: "Thanks. We'll reply by email.",
  error: "That didn't go through. Please check your email and store URL, or email us instead.",
  paid: "Payment received. We'll email you to schedule the install.",
  payButton: "Pay for the pilot",
} as const;

export const OFFERS_MARKER = "<!-- prism:offers -->";

const TEST_LINK_PREFIX = "https://buy.stripe.com/test_";

export type OfferId = "discovery" | "pilot" | "retain";

export type Offer = {
  id: OfferId;
  name: string;
  priceLabel: string;
  lines: readonly string[];
};

export const offers: readonly Offer[] = [
  {
    id: "discovery",
    name: "Discovery",
    priceLabel: "Free",
    lines: ["{price} for the first 5 stores."],
  },
  {
    id: "pilot",
    name: "Pilot",
    priceLabel: "$750",
    lines: [
      "{price} flat for 30 days.",
      "Full refund if setup or the day 30 report is not delivered.",
      "There is no lift guarantee.",
      "Orders and revenue are tracked.",
    ],
  },
  {
    id: "retain",
    name: "Retain",
    priceLabel: "$299/mo",
    lines: ["Ongoing management is {price}, month to month."],
  },
];

export type PayAudience = "nobody" | "operator" | "everyone";

export type BillingDecision =
  | { mode: "off"; effectiveMode: "off"; paymentLink: null; payAudience: "nobody" }
  | { mode: "test"; effectiveMode: "off"; paymentLink: null; payAudience: "nobody" }
  | { mode: "test"; effectiveMode: "test"; paymentLink: string; payAudience: "operator" }
  | { mode: "live"; effectiveMode: "off"; paymentLink: null; payAudience: "nobody" }
  | { mode: "live"; effectiveMode: "live"; paymentLink: string; payAudience: "everyone" };

export type BillingEnv = {
  BILLING_MODE?: string;
  PILOT_PAYMENT_LINK?: string;
  BILLING_LIVE_APPROVED?: string;
};

export function billingDecision(env: BillingEnv): BillingDecision {
  const raw = (env.BILLING_MODE ?? "").trim();
  const link = (env.PILOT_PAYMENT_LINK ?? "").trim();
  if (raw === "" || raw === "off") return { mode: "off", effectiveMode: "off", paymentLink: null, payAudience: "nobody" };
  if (raw !== "test" && raw !== "live") {
    console.error(`billing: unknown BILLING_MODE ${JSON.stringify(raw)}, treating as off`);
    return { mode: "off", effectiveMode: "off", paymentLink: null, payAudience: "nobody" };
  }
  if (raw === "test") {
    if (!link.startsWith(TEST_LINK_PREFIX)) {
      console.error("billing: BILLING_MODE=test requires PILOT_PAYMENT_LINK to start with https://buy.stripe.com/test_");
      return { mode: "test", effectiveMode: "off", paymentLink: null, payAudience: "nobody" };
    }
    return { mode: "test", effectiveMode: "test", paymentLink: link, payAudience: "operator" };
  }
  if (env.BILLING_LIVE_APPROVED !== "yes" || !livePaymentLink(link)) {
    console.error("billing: BILLING_MODE=live requires BILLING_LIVE_APPROVED=yes and a live https://buy.stripe.com Payment Link");
    return { mode: "live", effectiveMode: "off", paymentLink: null, payAudience: "nobody" };
  }
  return { mode: "live", effectiveMode: "live", paymentLink: link, payAudience: "everyone" };
}

function livePaymentLink(link: string): boolean {
  if (link.startsWith(TEST_LINK_PREFIX)) return false;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "buy.stripe.com" && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export type PayView = { showPay: boolean; paymentLink: string | null };

export function renderOffers(pay: PayView): string {
  const cards = offers.map((offer) => {
    const lines = offer.lines.map((line) => `<p>${esc(fillPrice(line, offer.priceLabel))}</p>`).join("");
    const button = offer.id === "pilot" && pay.showPay && pay.paymentLink
      ? `<a class="btn solid" href="${esc(pay.paymentLink)}">${pilotCopy.payButton}</a>`
      : "";
    const hot = offer.id === "pilot" ? " hot" : "";
    return `<article class="offer${hot}"><h3>${esc(offer.name)}</h3><div class="offer-price">${esc(offer.priceLabel)}</div>${lines}${button}</article>`;
  }).join("");
  return `<div class="offer-grid">${cards}</div>`;
}

export function applyOffers(html: string, pay: PayView): string {
  return html.replace(OFFERS_MARKER, renderOffers(pay));
}

function fillPrice(line: string, priceLabel: string): string {
  return line.replaceAll("{price}", priceLabel);
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const MAX_EMAIL = 254;
const MAX_STORE_URL = 500;
const MAX_MONTHLY = 80;
const MAX_NOTE = 2000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PilotInquiry = {
  email: string;
  storeUrl: string;
  monthlyVisitors: string | null;
  note: string | null;
};

export function parsePilotInquiry(raw: unknown): { ok: true; inquiry: PilotInquiry } | { ok: false } {
  if (!raw || typeof raw !== "object") return { ok: false };
  const body = raw as Record<string, unknown>;
  if (text(body.company) !== "") return { ok: false };

  const email = text(body.email);
  const storeUrl = text(body.storeUrl);
  const monthlyVisitors = text(body.monthlyVisitors);
  const note = text(body.note);
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) return { ok: false };
  if (!storeUrl || storeUrl.length > MAX_STORE_URL || !httpUrl(storeUrl)) return { ok: false };
  if (monthlyVisitors.length > MAX_MONTHLY || note.length > MAX_NOTE) return { ok: false };

  return {
    ok: true,
    inquiry: {
      email,
      storeUrl,
      monthlyVisitors: monthlyVisitors || null,
      note: note || null,
    },
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function pilotPage(view: "form" | "thanks" | "error" | "paid" = "form", pay: PayView = { showPay: false, paymentLink: null }): string {
  const status = view === "paid"
    ? `<p class="status" role="status">${pilotCopy.paid}</p>`
    : view === "thanks"
      ? `<p class="status" role="status">${pilotCopy.thanks}</p>`
      : view === "error"
        ? `<p class="status err" role="alert">${pilotCopy.error}</p>`
        : "";
  const form = view === "thanks" || view === "paid" ? "" : `<form method="post" action="/api/pilot/inquiry">
        <div class="hp" aria-hidden="true">
          <label for="company">Company</label>
          <input id="company" name="company" type="text" tabindex="-1" autocomplete="off">
        </div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        <label for="storeUrl">Store URL</label>
        <input id="storeUrl" name="storeUrl" type="url" required placeholder="https://your-store.com" autocomplete="url">
        <div class="label-row">
          <label for="monthlyVisitors">Monthly visitors</label>
          <span>Optional</span>
        </div>
        <input id="monthlyVisitors" name="monthlyVisitors" type="text" autocomplete="off">
        <div class="label-row">
          <label for="note">Note</label>
          <span>Optional</span>
        </div>
        <textarea id="note" name="note" rows="4"></textarea>
        <button class="btn solid" type="submit">${pilotCopy.submit}</button>
      </form>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view === "paid" ? "Payment received" : pilotCopy.heading}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root { --ink: #111312; --paper: #fdfdfb; --mute: #555a56; --hair: #e2e4df; --b: #3a6fd8; --r: #e5453c; }
  * { box-sizing: border-box; margin: 0; }
  :focus-visible { outline: 2px solid var(--b); outline-offset: 3px; }
  body { font: 400 16px/1.6 "IBM Plex Sans", system-ui, sans-serif; background: var(--paper); color: var(--ink); }
  a { color: inherit; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 32px; }
  .site-nav { border-bottom: 1px solid var(--hair); }
  .site-nav .wrap { display: flex; align-items: center; justify-content: space-between; height: 72px; }
  .wordmark { font-weight: 600; font-size: 17px; letter-spacing: .02em; text-decoration: none; }
  .wordmark em { font-style: normal; color: var(--b); }
  .site-nav .back { font-size: 14px; text-decoration: none; color: var(--mute); }
  .site-nav .back:hover { color: var(--ink); }
  main { padding: 64px 0 96px; }
  h1 { font-size: clamp(32px, 4vw, 44px); font-weight: 500; letter-spacing: -0.02em; line-height: 1.1; max-width: 16ch; }
  .lede { margin-top: 16px; max-width: 52ch; color: var(--mute); font-size: 17px; font-weight: 300; }
  form { position: relative; margin-top: 36px; max-width: 32rem; }
  label { display: block; margin-top: 18px; font-size: 14px; font-weight: 500; }
  .label-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .label-row span { font: 12px/1.4 "IBM Plex Mono", monospace; color: var(--mute); }
  input, textarea {
    width: 100%; margin-top: 6px; padding: 12px 14px;
    font: 16px/1.4 "IBM Plex Sans", system-ui, sans-serif;
    color: var(--ink); background: #fff; border: 1px solid var(--hair); border-radius: 3px;
  }
  textarea { resize: vertical; }
  .btn {
    display: inline-block; margin-top: 22px; font: 500 15px "IBM Plex Sans", sans-serif;
    padding: 12px 24px; border-radius: 3px; border: 1px solid var(--ink); cursor: pointer;
  }
  .btn.solid { background: var(--ink); color: var(--paper); }
  .btn.solid:hover { background: #2a2d2b; }
  .status { margin-top: 28px; max-width: 40ch; font-size: 17px; }
  .status.err { color: var(--r); }
  .fallback { margin-top: 28px; color: var(--mute); font-size: 15px; }
  .fallback a { color: var(--ink); }
  .hp { position: absolute; top: 0; left: 0; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .offer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 28px; }
  .offer { border: 1px solid var(--hair); border-radius: 4px; padding: 20px; }
  .offer.hot { border-color: var(--ink); }
  .offer h3 { font-size: 16px; font-weight: 600; }
  .offer-price { font-size: 28px; font-weight: 500; letter-spacing: -0.02em; margin-top: 4px; }
  .offer p { margin-top: 10px; color: var(--mute); font-size: 14px; }
  .offer .btn { margin-top: 16px; text-decoration: none; }
  @media (max-width: 720px) {
    .wrap { padding: 0 20px; }
    .site-nav .wrap { height: 60px; }
    main { padding: 40px 0 72px; }
    .offer-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<nav class="site-nav" aria-label="Primary">
  <div class="wrap">
    <a class="wordmark" href="/">Prism<em>.</em></a>
    <a class="back" href="/#pricing">Pricing</a>
  </div>
</nav>
<main>
  <div class="wrap">
    <h1>${view === "paid" ? "Payment received" : pilotCopy.heading}</h1>
    ${view === "paid" ? "" : `<p class="lede">${pilotCopy.body}</p>`}
    ${renderOffers(view === "paid" ? { showPay: false, paymentLink: null } : pay)}
    ${status}
    ${form}
    <p class="fallback">Prefer email? Write to <a href="${pilotCopy.mailto}">hello@sundaymorning.software</a>.</p>
  </div>
</main>
</body>
</html>`;
}
