// Prism — open a SQLite file with the same schema and migrate boot uses.
import { Database } from "bun:sqlite";
import { installEventCounts } from "./counts";

export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  traits TEXT NOT NULL DEFAULT '{}'   -- JSON: {orders: n, lastOrderDays: n, affinity: 'woody', cartItems: n}
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  name TEXT NOT NULL,
  selector TEXT NOT NULL,             -- CSS selector of the component to personalize
  ops TEXT NOT NULL,                  -- JSON array of ops: [{op:'html'|'text'|'insertBefore'|'insertAfter'|'remove'|'reorder'|'setAttr', ...}]
  audience TEXT NOT NULL DEFAULT '{}',-- JSON rule: {field, op, value}[] — all must match
  weight REAL NOT NULL DEFAULT 1,     -- bandit prior scale
  starts_at INTEGER,                  -- null = eligible immediately
  ends_at INTEGER,                    -- null = never expires; promos auto-stop
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  variant_id INTEGER,                 -- null for control (no variant applied)
  selector TEXT NOT NULL,
  type TEXT NOT NULL,                 -- 'impression' | 'conversion'
  ts INTEGER NOT NULL,
  audience_key TEXT                   -- null on events recorded before per-audience attribution
);
CREATE INDEX IF NOT EXISTS idx_events_variant ON events(variant_id, type);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);

CREATE TABLE IF NOT EXISTS sites (
  site TEXT PRIMARY KEY,
  plan TEXT NOT NULL,                   -- key into PLANS (src/plans.ts)
  created_at INTEGER NOT NULL,
  holdout_pct INTEGER                   -- null = use the HOLDOUT_PCT env default
);

CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,               -- Google identity, lowercased
  role TEXT NOT NULL DEFAULT 'editor',  -- owner | editor | viewer (viewer = read-only seat)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pilot_inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  store_url TEXT NOT NULL,
  monthly_visitors TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
`);

  // Existing DBs: add columns if missing (CREATE TABLE IF NOT EXISTS won't).
  for (const col of ["starts_at INTEGER", "ends_at INTEGER"]) {
    try { db.exec(`ALTER TABLE variants ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  try { db.exec("ALTER TABLE events ADD COLUMN audience_key TEXT"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE sites ADD COLUMN holdout_pct INTEGER"); } catch { /* already there */ }
  const siteCols = db.prepare("PRAGMA table_info(sites)").all() as { name: string }[];
  if (!siteCols.some((col) => col.name === "write_key")) {
    db.exec("ALTER TABLE sites ADD COLUMN write_key TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_write_key ON sites(write_key) WHERE write_key IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_audience ON events(site, audience_key, selector, type)");

  // Orders are their own fact. One row per site and order id. Credits name the
  // arms the visitor had already seen when the order was accepted.
  db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  site TEXT NOT NULL,
  order_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  value_minor INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (site, order_id)
);
CREATE TABLE IF NOT EXISTS order_credits (
  site TEXT NOT NULL,
  order_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  PRIMARY KEY (site, order_id, arm)
);
CREATE INDEX IF NOT EXISTS idx_orders_visitor ON orders(site, visitor_id);
CREATE INDEX IF NOT EXISTS idx_order_credits_arm ON order_credits(site, arm);
`);

  // Marketing-site counts (landing and /pilot). One row per count. No visitor id,
  // no cookie, no IP. UTM fields and the referrer host are the only attribution.
  db.exec(`
CREATE TABLE IF NOT EXISTS growth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  day TEXT NOT NULL,
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_growth_day ON growth_events(day, event);
`);

  db.exec(`
CREATE TABLE IF NOT EXISTS account_sites (
  email TEXT NOT NULL,
  site TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (email, site),
  FOREIGN KEY (email) REFERENCES accounts(email)
);
`);

  installEventCounts(db);
  return db;
}
