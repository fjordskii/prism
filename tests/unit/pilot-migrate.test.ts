// PRISM-032: booting on a pre-change database adds pilot_inquiries and keeps existing rows.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("importing the db module adds pilot_inquiries without dropping existing rows", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "prism-migrate-")), "prism.db");
  const old = new Database(path);
  old.exec(`
    CREATE TABLE visitors (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      traits TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits)
    VALUES ('keep-me', 'demo', 10, 20, 4, '{"orders":2}');
    CREATE TABLE variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      name TEXT NOT NULL,
      selector TEXT NOT NULL,
      ops TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '{}',
      weight REAL NOT NULL DEFAULT 1,
      starts_at INTEGER,
      ends_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO variants (site, name, selector, ops, audience, created_at) VALUES ('demo', 'Hero', '#hero', '[]', '[]', 10);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant_id INTEGER,
      selector TEXT NOT NULL,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES ('demo', 'keep-me', 1, '#hero', 'impression', 11);
    CREATE TABLE sites (site TEXT PRIMARY KEY, plan TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO sites (site, plan, created_at) VALUES ('demo', 'growth', 9);
    CREATE TABLE accounts (email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL);
    INSERT INTO accounts (email, role, created_at) VALUES ('owner@prism.test', 'owner', 8);
  `);
  old.close();

  process.env.DB_PATH = path;
  const { db } = await import("../../src/db.ts");

  const visitor = db.prepare("SELECT id, site, visits, traits FROM visitors WHERE id = ?").get("keep-me");
  expect(visitor).toEqual({ id: "keep-me", site: "demo", visits: 4, traits: '{"orders":2}' });
  expect((db.prepare("SELECT COUNT(*) AS n FROM variants").get() as { n: number }).n).toBe(1);
  expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(1);
  expect((db.prepare("SELECT plan FROM sites WHERE site = ?").get("demo") as { plan: string }).plan).toBe("growth");
  expect((db.prepare("SELECT role FROM accounts WHERE email = ?").get("owner@prism.test") as { role: string }).role).toBe("owner");

  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pilot_inquiries'").get();
  expect(table).toEqual({ name: "pilot_inquiries" });
  expect((db.prepare("SELECT COUNT(*) AS n FROM pilot_inquiries").get() as { n: number }).n).toBe(0);
});
