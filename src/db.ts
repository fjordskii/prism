// Prism — personalization engine. SQLite schema + db handle.
import { Database } from "bun:sqlite";

export const db = new Database(process.env.DB_PATH ?? "prism.db");
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
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_variant ON events(variant_id, type);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events(visitor_id);
`);

export type Variant = {
  id: number;
  site: string;
  name: string;
  selector: string;
  ops: string;      // JSON
  audience: string; // JSON
  weight: number;
  starts_at: number | null;
  ends_at: number | null;
  active: number;
  created_at: number;
};

// Existing DBs: add scheduling columns if missing (CREATE TABLE IF NOT EXISTS won't).
for (const col of ["starts_at INTEGER", "ends_at INTEGER"]) {
  try { db.exec(`ALTER TABLE variants ADD COLUMN ${col}`); } catch { /* already there */ }
}

export type Op =
  | { op: "html"; html: string }
  | { op: "text"; text: string }
  | { op: "insertBefore"; html: string }
  | { op: "insertAfter"; html: string }
  | { op: "remove" }
  | { op: "setAttr"; name: string; value: string }
  | { op: "reorder"; order: string[] }; // child selectors in desired order

export type Rule = { field: string; op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains"; value: unknown };

export function matchAudience(rules: Rule[], traits: Record<string, unknown>): boolean {
  return rules.every((r) => {
    const v = traits[r.field];
    switch (r.op) {
      case "eq": return v === r.value;
      case "neq": return v !== r.value;
      case "gt": return typeof v === "number" && v > (r.value as number);
      case "lt": return typeof v === "number" && v < (r.value as number);
      case "gte": return typeof v === "number" && v >= (r.value as number);
      case "lte": return typeof v === "number" && v <= (r.value as number);
      case "contains":
        return Array.isArray(v) ? v.includes(r.value) : typeof v === "string" && v.includes(String(r.value));
      default: return false;
    }
  });
}
