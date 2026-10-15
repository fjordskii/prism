import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openDatabase } from "../../src/open-db";

const repo = join(import.meta.dir, "../..");
const ADOPT_TIMEOUT = 60_000;

function baseEnv(dbPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("AWS_") || key.startsWith("S3_")) continue;
    env[key] = value;
  }
  env.DB_PATH = dbPath;
  return env;
}

async function runAdopt(dbPath: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "src/backup.ts", "adopt"], {
    cwd: repo,
    env: { ...baseEnv(dbPath), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function writeVisitors(path: string, ids: number[]) {
  const db = new Database(path);
  db.exec("CREATE TABLE visitors (id INTEGER PRIMARY KEY)");
  const insert = db.query("INSERT INTO visitors (id) VALUES (?)");
  for (const id of ids) insert.run(id);
  db.close();
}

function writeWrongColumns(path: string, ids: number[]) {
  const db = new Database(path);
  for (const name of [
    "visitors",
    "variants",
    "events",
    "sites",
    "accounts",
    "pilot_inquiries",
    "orders",
    "order_credits",
    "growth_events",
    "account_sites",
  ]) {
    db.exec(`CREATE TABLE "${name}" (id INTEGER PRIMARY KEY)`);
  }
  const insert = db.query("INSERT INTO visitors (id) VALUES (?)");
  for (const id of ids) insert.run(id);
  db.close();
}

function writeBootable(path: string, ids: string[]) {
  const db = openDatabase(path);
  const insert = db.query(
    "INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits) VALUES (?, 'demo', 1, 1, 0, '{}')",
  );
  for (const id of ids) insert.run(id);
  db.close();
}

function writeOlderSchema(path: string, visitorId: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE visitors (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      traits TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits)
    VALUES (${sqlString(visitorId)}, 'demo', 10, 20, 4, '{"orders":2}');
    CREATE TABLE variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      name TEXT NOT NULL,
      selector TEXT NOT NULL,
      ops TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '{}',
      weight REAL NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO variants (site, name, selector, ops, audience, created_at)
    VALUES ('demo', 'Hero', '#hero', '[]', '[]', 10);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      variant_id INTEGER,
      selector TEXT NOT NULL,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    INSERT INTO events (site, visitor_id, variant_id, selector, type, ts)
    VALUES ('demo', ${sqlString(visitorId)}, 1, '#hero', 'impression', 11);
    CREATE TABLE sites (site TEXT PRIMARY KEY, plan TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO sites (site, plan, created_at) VALUES ('demo', 'growth', 9);
    CREATE TABLE accounts (email TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL);
    INSERT INTO accounts (email, role, created_at) VALUES ('owner@prism.test', 'owner', 8);
  `);
  db.close();
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function visitorCount(path: string): number {
  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT COUNT(*) AS n FROM visitors").get() as { n: number };
  db.close();
  return row.n;
}

function generationStamp(live: string, name: string): number {
  const prefix = `${basename(live)}.previous`;
  if (name === prefix) return 0;
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`).exec(name);
  return match?.[1] === undefined ? -1 : Number(match[1]);
}

function generations(live: string): string[] {
  const dir = dirname(live);
  return readdirSync(dir)
    .filter((name) => generationStamp(live, name) >= 0)
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => generationStamp(live, basename(b)) - generationStamp(live, basename(a)));
}

function visitorId(path: string): string {
  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT id FROM visitors").get() as { id: string };
  db.close();
  return row.id;
}

function mountTmpfs(size: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prism-tmpfs-"));
  const result = Bun.spawnSync(["sudo", "-n", "mount", "-t", "tmpfs", "-o", `size=${size},mode=1777`, "tmpfs", dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`tmpfs mount failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return dir;
}

function unmountTmpfs(dir: string): void {
  Bun.spawnSync(["sudo", "-n", "umount", "-l", dir], { stdout: "pipe", stderr: "pipe" });
  rmSync(dir, { recursive: true, force: true });
}

function fillUntil(dir: string, remain: number): void {
  const pad = join(dir, ".pad");
  const fd = openSync(pad, "w");
  try {
    const st = statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    let left = Math.max(0, free - remain);
    const buf = Buffer.alloc(64 * 1024, 1);
    while (left > 0) {
      const n = Math.min(left, buf.length);
      try {
        left -= writeSync(fd, buf, 0, n);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOSPC") return;
        throw err;
      }
    }
  } finally {
    closeSync(fd);
  }
}

test("adopt with no pending file leaves the live database in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-clear-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1, 2, 3, 4, 5, 6, 7]);
  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(7);
}, { timeout: ADOPT_TIMEOUT });

test("matching table names with the wrong columns are rejected and live stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-wrong-cols-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["keep-1", "keep-2"]);
  const before = readFileSync(live);
  const pending = join(dir, "prism.restore");
  writeWrongColumns(pending, [1, 2, 3]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toContain("adopt: moved stray restore aside to ");
  expect(result.stderr).toMatch(/no such column: variant_id/);
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(true);
  expect(generations(live)).toEqual([]);
  expect(visitorCount(live)).toBe(2);
}, { timeout: ADOPT_TIMEOUT });

test("an older-schema backup is adopted and migrates up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-migrate-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["old-live"]);
  const pending = join(dir, "prism.restore");
  writeOlderSchema(pending, "keep-me");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(existsSync(pending)).toBe(false);
  expect(visitorCount(live)).toBe(1);

  const migrated = openDatabase(live);
  const visitor = migrated.query("SELECT id, visits, traits FROM visitors WHERE id = ?").get("keep-me") as {
    id: string;
    visits: number;
    traits: string;
  };
  expect(visitor).toEqual({ id: "keep-me", visits: 4, traits: '{"orders":2}' });
  const events = migrated.query("PRAGMA table_info(events)").all() as { name: string }[];
  expect(events.some((col) => col.name === "audience_key")).toBe(true);
  const sites = migrated.query("PRAGMA table_info(sites)").all() as { name: string }[];
  expect(sites.some((col) => col.name === "write_key")).toBe(true);
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name = 'account_sites'").get()).toEqual({
    name: "account_sites",
  });
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name = 'pilot_inquiries'").get()).toEqual({
    name: "pilot_inquiries",
  });
  migrated.close();

  const gens = generations(live);
  expect(gens).toHaveLength(1);
  expect(basename(gens[0]!)).toMatch(/^prism\.db\.previous\.\d+$/);
  expect(visitorCount(gens[0]!)).toBe(1);
}, { timeout: ADOPT_TIMEOUT });

test("adopt checkpoints live WAL into a timestamped generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-wal-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["committed"]);
  const writer = new Database(live);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.run(
    "INSERT INTO visitors (id, site, first_seen, last_seen, visits, traits) VALUES ('wal-only', 'demo', 2, 2, 0, '{}')",
  );
  writer.close();
  expect(existsSync(`${live}-wal`)).toBe(true);

  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["restored"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(visitorCount(live)).toBe(1);
  expect(existsSync(pending)).toBe(false);

  const gens = generations(live);
  expect(gens).toHaveLength(1);
  const displaced = new Database(gens[0]!);
  const ids = displaced.query("SELECT id FROM visitors ORDER BY id").all() as { id: string }[];
  displaced.close();
  expect(ids.map((row) => row.id)).toEqual(["committed", "wal-only"]);
}, { timeout: ADOPT_TIMEOUT });

test("adopt keeps the three newest generations by timestamp, not mtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-gens-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["live"]);
  writeBootable(`${live}.previous.9`, ["g9"]);
  writeBootable(`${live}.previous.10`, ["g10"]);
  writeBootable(`${live}.previous.11`, ["g11"]);
  writeBootable(`${live}.previous.100`, ["g100"]);
  const now = Date.now() / 1000;
  utimesSync(`${live}.previous.9`, now, now);
  utimesSync(`${live}.previous.10`, now - 30, now - 30);
  utimesSync(`${live}.previous.11`, now - 20, now - 20);
  utimesSync(`${live}.previous.100`, now - 40, now - 40);
  writeBootable(join(dir, "prism.restore"), ["fresh"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, adopted: true, path: live });
  expect(visitorId(live)).toBe("fresh");

  const gens = generations(live);
  expect(gens).toHaveLength(3);
  expect(visitorId(gens[0]!)).toBe("live");
  expect(basename(gens[0]!)).toMatch(/^prism\.db\.previous\.\d+$/);
  expect(Number(basename(gens[0]!).slice("prism.db.previous.".length))).toBeGreaterThan(100);
  expect(gens.slice(1).map((path) => basename(path))).toEqual(["prism.db.previous.100", "prism.db.previous.11"]);
  expect(gens.slice(1).map(visitorId)).toEqual(["g100", "g11"]);
  expect(existsSync(`${live}.previous.9`)).toBe(false);
  expect(existsSync(`${live}.previous.10`)).toBe(false);
}, { timeout: ADOPT_TIMEOUT });

test("a pending file that is not a database is moved aside and the live file stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-bad-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1, 2, 3, 4]);
  const before = readFileSync(live);
  const pending = join(dir, "prism.restore");
  writeFileSync(pending, "not a database");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toContain("adopt: moved stray restore aside to ");
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(true);
  expect(generations(live)).toEqual([]);
  expect(visitorCount(live)).toBe(4);
}, { timeout: ADOPT_TIMEOUT });

test("adopt finishes a swap that stopped after the live file was moved aside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-aside-"));
  const live = join(dir, "prism.db");
  writeBootable(`${live}.previous.1000`, ["aside-live"]);
  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["new-a", "new-b"]);
  writeFileSync(`${live}-wal`, "old-wal");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(visitorCount(live)).toBe(2);
  expect(existsSync(pending)).toBe(false);
  expect(visitorCount(`${live}.previous.1000`)).toBe(1);
}, { timeout: ADOPT_TIMEOUT });

test("a rejected candidate does not touch timestamped generations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-aside-bad-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["live-row"]);
  writeBootable(`${live}.previous.2000`, ["gen-row"]);
  writeFileSync(join(dir, "prism.restore"), "not a database");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toContain("adopt: moved stray restore aside to ");
  expect(visitorCount(live)).toBe(1);
  expect(visitorCount(`${live}.previous.2000`)).toBe(1);
  expect(existsSync(join(dir, "prism.restore"))).toBe(false);
  expect(existsSync(join(dir, "prism.restore.rejected"))).toBe(true);
}, { timeout: ADOPT_TIMEOUT });

test("a restore symlink to the live database is ignored and generations stay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-symlink-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["sym-live"]);
  writeBootable(`${live}.previous.3000`, ["sym-gen"]);
  symlinkSync(live, join(dir, "prism.restore"));

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(1);
  expect(visitorCount(`${live}.previous.3000`)).toBe(1);
  expect(lstatSync(join(dir, "prism.restore")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(dir, "prism.restore.rejected"))).toBe(false);
}, { timeout: ADOPT_TIMEOUT });

test("adopt restores the newest generation when live is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-rollback-"));
  const live = join(dir, "prism.db");
  writeBootable(`${live}.previous.4000`, ["a", "b", "c", "d"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(4);
  expect(visitorCount(`${live}.previous.4000`)).toBe(4);
}, { timeout: ADOPT_TIMEOUT });

test("adopt keeps a leftover previous file beside the live database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-leftover-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["l1", "l2", "l3"]);
  writeBootable(`${live}.previous.5000`, ["p1"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(3);
  expect(visitorCount(`${live}.previous.5000`)).toBe(1);
}, { timeout: ADOPT_TIMEOUT });

test("a zero-byte restore is rejected and the live database stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-zero-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["z1", "z2", "z3"]);
  const before = readFileSync(live);
  const pending = join(dir, "prism.restore");
  writeFileSync(pending, "");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toContain("adopt: moved stray restore aside to ");
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(true);
  expect(visitorCount(live)).toBe(3);
  expect(generations(live)).toEqual([]);
}, { timeout: ADOPT_TIMEOUT });

test("a sqlite file with no Prism tables is rejected and the live database stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-schema-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["s1", "s2"]);
  const before = readFileSync(live);
  const pending = join(dir, "prism.restore");
  const empty = new Database(pending);
  empty.exec("PRAGMA user_version = 1");
  empty.exec("CREATE TABLE other (id INTEGER PRIMARY KEY)");
  empty.close();

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toContain("adopt: moved stray restore aside to ");
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(true);
  expect(visitorCount(live)).toBe(2);
}, { timeout: ADOPT_TIMEOUT });

test("a failed adopt leaves an existing previous file in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-keep-prev-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["k1", "k2", "k3", "k4"]);
  writeBootable(`${live}.previous.6000`, ["kept"]);
  const pending = join(dir, "prism.restore");
  writeFileSync(pending, "");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(4);
  expect(visitorCount(`${live}.previous.6000`)).toBe(1);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(true);
}, { timeout: ADOPT_TIMEOUT });

test("a .previous directory does not stop adopt from starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-prev-dir-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["dir-live"]);
  mkdirSync(`${live}.previous`);
  writeFileSync(join(`${live}.previous`, "junk"), "nope");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(1);
  expect(lstatSync(`${live}.previous`).isDirectory()).toBe(true);
}, { timeout: ADOPT_TIMEOUT });

test("a .previous directory does not block a successful adopt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-prev-dir-swap-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["before"]);
  mkdirSync(`${live}.previous`);
  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["after-1", "after-2"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(visitorCount(live)).toBe(2);
  expect(lstatSync(`${live}.previous`).isDirectory()).toBe(true);
  const gens = generations(live);
  expect(gens).toHaveLength(1);
  expect(basename(gens[0]!)).toMatch(/^prism\.db\.previous\.\d+$/);
  expect(visitorCount(gens[0]!)).toBe(1);
}, { timeout: ADOPT_TIMEOUT });

test("boot fallback restores the newest generation when live cannot boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-fallback-"));
  const live = join(dir, "prism.db");
  writeWrongColumns(live, [1]);
  writeBootable(`${live}.previous.100`, ["stale"]);
  writeBootable(`${live}.previous.900`, ["newest"]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(result.stderr).toMatch(/live database failed boot/i);
  expect(result.stderr).toContain(`${live}.previous.900`);
  const db = openDatabase(live);
  const row = db.query("SELECT id FROM visitors").get() as { id: string };
  db.close();
  expect(row.id).toBe("newest");
  expect(visitorCount(`${live}.previous.900`)).toBe(1);
}, { timeout: ADOPT_TIMEOUT });

test("ENOSPC while proving a candidate leaves live and pending in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-enospc-copy-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["keep-live"]);
  writeBootable(`${live}.previous.50`, ["keep-gen"]);
  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["candidate"]);
  const before = readFileSync(live);

  const result = await runAdopt(live, { PRISM_ADOPT_INJECT: "enospc-copy" });
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: "ENOSPC: no space left on device" });
  expect(result.stderr).toContain("prove deferred");
  expect(readFileSync(live)).toEqual(before);
  expect(visitorId(live)).toBe("keep-live");
  expect(visitorId(pending)).toBe("candidate");
  expect(visitorId(`${live}.previous.50`)).toBe("keep-gen");
  expect(existsSync(`${live}.unbootable`)).toBe(false);
  expect(existsSync(`${pending}.rejected`)).toBe(false);
  expect(generations(live)).toEqual([`${live}.previous.50`]);
}, { timeout: ADOPT_TIMEOUT });

test("ENOSPC during the swap leaves live in place and does not seed a hole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-enospc-swap-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["keep-live"]);
  writeBootable(`${live}.previous.60`, ["keep-gen"]);
  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["candidate"]);
  const before = readFileSync(live);

  const result = await runAdopt(live, { PRISM_ADOPT_INJECT: "enospc-swap" });
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(readFileSync(live)).toEqual(before);
  expect(visitorId(live)).toBe("keep-live");
  expect(visitorId(pending)).toBe("candidate");
  expect(existsSync(`${live}.unbootable`)).toBe(false);
  expect(generations(live)).toEqual([`${live}.previous.60`]);
}, { timeout: ADOPT_TIMEOUT });

test("ENOSPC after live is displaced puts the original live back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-enospc-undo-"));
  const live = join(dir, "prism.db");
  writeBootable(live, ["keep-live"]);
  const pending = join(dir, "prism.restore");
  writeBootable(pending, ["candidate"]);

  const result = await runAdopt(live, { PRISM_ADOPT_INJECT: "enospc-swap-after-displace" });
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(visitorId(live)).toBe("keep-live");
  expect(existsSync(pending)).toBe(true);
  expect(visitorId(pending)).toBe("candidate");
  expect(generations(live)).toEqual([]);
}, { timeout: ADOPT_TIMEOUT });

test("a full TMPDIR does not demote live because prove copies next to the database", async () => {
  const tiny = mountTmpfs("256k");
  try {
    const dir = mkdtempSync(join(tmpdir(), "prism-adopt-tmpdir-"));
    const live = join(dir, "prism.db");
    writeBootable(live, ["keep-live"]);
    writeBootable(join(dir, "prism.restore"), ["fresh"]);
    const result = await runAdopt(live, { TMPDIR: tiny, TMP: tiny });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, adopted: true, path: live });
    expect(visitorId(live)).toBe("fresh");
    expect(visitorId(generations(live)[0]!)).toBe("keep-live");
  } finally {
    unmountTmpfs(tiny);
  }
}, { timeout: ADOPT_TIMEOUT });

test("a full data volume during prove leaves live and pending untouched", async () => {
  const volume = mountTmpfs("2m");
  try {
    const live = join(volume, "prism.db");
    writeBootable(live, ["keep-live"]);
    writeBootable(`${live}.previous.70`, ["keep-gen"]);
    const pending = join(volume, "prism.restore");
    writeBootable(pending, ["candidate"]);
    fillUntil(volume, 24_576);
    const before = readFileSync(live);

    const result = await runAdopt(live);
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(String(JSON.parse(result.stdout).error)).toMatch(/ENOSPC|no space left/i);
    expect(readFileSync(live)).toEqual(before);
    expect(visitorId(live)).toBe("keep-live");
    expect(existsSync(pending)).toBe(true);
    expect(existsSync(`${live}.unbootable`)).toBe(false);
    expect(existsSync(`${pending}.rejected`)).toBe(false);
  } finally {
    unmountTmpfs(volume);
  }
}, { timeout: ADOPT_TIMEOUT });
