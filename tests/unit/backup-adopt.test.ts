import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");

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

async function runAdopt(dbPath: string) {
  const proc = Bun.spawn(["bun", "src/backup.ts", "adopt"], {
    cwd: repo,
    env: baseEnv(dbPath),
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

function visitorCount(path: string): number {
  const db = new Database(path, { readonly: true });
  const row = db.query("SELECT COUNT(*) AS n FROM visitors").get() as { n: number };
  db.close();
  return row.n;
}

test("adopt with no pending file leaves the live database in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-clear-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1, 2, 3, 4, 5, 6, 7]);
  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(7);
});

test("adopt swaps prism.restore onto the live path and removes wal sidecars", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-pending-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1]);
  writeFileSync(`${live}-wal`, "old-wal");
  writeFileSync(`${live}-shm`, "old-shm");
  const pending = join(dir, "prism.restore");
  writeVisitors(pending, [1, 2]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(visitorCount(live)).toBe(2);
  expect(existsSync(`${live}-wal`)).toBe(false);
  expect(existsSync(`${live}-shm`)).toBe(false);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${live}.previous`)).toBe(false);
});

test("a pending file that is not a database does not move the live file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-bad-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1, 2, 3, 4]);
  const before = readFileSync(live);
  const pending = join(dir, "prism.restore");
  writeFileSync(pending, "not a database");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"SQLITE_NOTADB: file is not a database"}\n');
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(true);
  expect(existsSync(`${live}.previous`)).toBe(false);
  expect(visitorCount(live)).toBe(4);
});

test("adopt finishes a swap that stopped after the live file was moved aside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-aside-"));
  const live = join(dir, "prism.db");
  writeVisitors(`${live}.previous`, [1]);
  const pending = join(dir, "prism.restore");
  writeVisitors(pending, [1, 2]);
  writeFileSync(`${live}-wal`, "old-wal");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`{"ok":true,"adopted":true,"path":${JSON.stringify(live)}}\n`);
  expect(visitorCount(live)).toBe(2);
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(`${live}.previous`)).toBe(false);
  expect(existsSync(`${live}-wal`)).toBe(false);
});

test("adopt puts the previous database back when the aside file is not a database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-aside-bad-"));
  const live = join(dir, "prism.db");
  writeVisitors(`${live}.previous`, [1, 2, 3]);
  writeFileSync(join(dir, "prism.restore"), "not a database");

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"SQLITE_NOTADB: file is not a database"}\n');
  expect(visitorCount(live)).toBe(3);
  expect(existsSync(`${live}.previous`)).toBe(false);
  expect(existsSync(join(dir, "prism.restore"))).toBe(true);
});

test("adopt puts the previous database back when the pending file is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-rollback-"));
  const live = join(dir, "prism.db");
  writeVisitors(`${live}.previous`, [4, 5, 6, 7]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"restore incomplete; moved the previous database back"}\n');
  expect(visitorCount(live)).toBe(4);
  expect(existsSync(`${live}.previous`)).toBe(false);
});

test("adopt deletes a previous file once the new live file is in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-leftover-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [3, 4, 5]);
  writeVisitors(`${live}.previous`, [9]);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe('{"ok":true,"adopted":false}\n');
  expect(visitorCount(live)).toBe(3);
  expect(existsSync(`${live}.previous`)).toBe(false);
});

test("adopt refuses to move files when the pending file and the previous file both exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-adopt-both-"));
  const live = join(dir, "prism.db");
  writeVisitors(live, [1]);
  writeVisitors(`${live}.previous`, [8]);
  const pending = join(dir, "prism.restore");
  writeVisitors(pending, [1, 2]);
  const before = readFileSync(live);

  const result = await runAdopt(live);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"prism.db.previous already exists"}\n');
  expect(readFileSync(live)).toEqual(before);
  expect(existsSync(pending)).toBe(true);
  expect(visitorCount(`${live}.previous`)).toBe(1);
});
