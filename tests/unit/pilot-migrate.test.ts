// PRISM-032: a fresh boot on a pre-change database adds pilot_inquiries and keeps existing rows.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("booting on a pre-change database adds pilot_inquiries without dropping existing rows", async () => {
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

  const proc = Bun.spawn(["bun", "tests/support/boot-migrate.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, DB_PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    visitor: { id: "keep-me", site: "demo", visits: 4, traits: '{"orders":2}' },
    table: { name: "pilot_inquiries" },
    inquiries: 0,
    variants: 1,
    events: 1,
    site: { plan: "growth" },
    account: { role: "owner" },
  });
});
