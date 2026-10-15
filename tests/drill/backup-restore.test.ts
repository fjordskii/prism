import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");

function drillValue(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function childEnv(dbPath: string): Record<string, string> {
  const env: Record<string, string> = {
    S3_ENDPOINT: drillValue("S3_ENDPOINT", "http://127.0.0.1:9000"),
    S3_BUCKET: drillValue("S3_BUCKET", "prism-drill"),
    S3_ACCESS_KEY_ID: drillValue("S3_ACCESS_KEY_ID", "drill"),
    S3_SECRET_ACCESS_KEY: drillValue("S3_SECRET_ACCESS_KEY", "drilldrill"),
    S3_REGION: drillValue("S3_REGION", "us-east-1"),
    BACKUP_RETENTION_DAYS: drillValue("BACKUP_RETENTION_DAYS", "14"),
    DB_PATH: dbPath,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return env;
}

function clientFor(env: Record<string, string>): Bun.S3Client {
  return new Bun.S3Client({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    virtualHostedStyle: false,
  });
}

async function emptyDaily(env: Record<string, string>) {
  const client = clientFor(env);
  let continuationToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await client.list({
      prefix: "prism/daily/",
      maxKeys: 1000,
      ...(continuationToken ? { continuationToken } : {}),
    });
    for (const item of listed.contents ?? []) await client.file(item.key).delete();
    if (!listed.isTruncated || listed.nextContinuationToken === undefined) return;
    continuationToken = listed.nextContinuationToken;
  }
}

async function storedGzip(env: Record<string, string>, key: string): Promise<Uint8Array> {
  return new Uint8Array(await clientFor(env).file(key).arrayBuffer());
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/backup.ts", ...args], {
    cwd: repo,
    env,
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

async function writeShop(path: string) {
  const script = `
    process.env.DB_PATH = ${JSON.stringify(path)};
    const { db } = await import("./src/db.ts");
    const now = Date.now();
    db.run("INSERT INTO visitors (id, site, first_seen, last_seen, visits) VALUES ('v1', 'shop', ?, ?, 1)", now, now);
    db.run("INSERT INTO visitors (id, site, first_seen, last_seen, visits) VALUES ('v2', 'shop', ?, ?, 1)", now, now);
    db.run("INSERT INTO variants (site, name, selector, ops, audience, created_at) VALUES ('shop', 'Hero', '#hero', '[]', '{}', ?)", now);
    db.run("INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES ('shop', 'v1', 1, '#hero', 'impression', ?)", now);
    db.run("INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES ('shop', 'v1', 1, '#hero', 'conversion', ?)", now);
    db.run("INSERT INTO events (site, visitor_id, variant_id, selector, type, ts) VALUES ('shop', 'v2', 1, '#hero', 'impression', ?)", now);
    db.run("INSERT INTO sites (site, plan, created_at) VALUES ('shop', 'growth', ?)", now);
    db.run("INSERT INTO orders (site, order_id, visitor_id, currency, value_minor, ts) VALUES ('shop', 'ord-1', 'v1', 'USD', 100, ?)", now);
    db.close();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: repo,
    env: { ...process.env, DB_PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`writeShop failed\n${stderr}\n${stdout}`);
}

function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + delta)).toISOString().slice(0, 10);
}

async function holdOpen(path: string) {
  const holder = Bun.spawn(["bun", "tests/support/hold-db.ts", path], {
    cwd: repo,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = holder.stdout.getReader();
  const decoder = new TextDecoder();
  let banner = "";
  while (!banner.includes("open\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(holder.stderr).text();
      throw new Error(`holder exited before open\n${stderr}`);
    }
    banner += decoder.decode(chunk.value, { stream: true });
  }
  return holder;
}

test.serial(
  "snapshot while a second process holds the database open restores the inserted counts",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-drill-wal-"));
    const live = join(dir, "shop.sqlite");
    const restored = join(dir, "shop-restored.sqlite");
    await writeShop(live);
    const env = childEnv(live);
    await emptyDaily(env);

    const holder = await holdOpen(live);
    expect(holder.exitCode).toBe(null);

    const snap = await runCli(["snapshot", "--day", "2026-06-15"], env);
    expect(holder.exitCode).toBe(null);
    expect(snap.code, snap.stderr).toBe(0);
    const key = "prism/daily/2026-06-15.sqlite.gz";
    const gz = await storedGzip(env, key);
    const sha256 = new Bun.CryptoHasher("sha256").update(gz).digest("hex");
    expect(JSON.parse(snap.stdout)).toEqual({
      ok: true,
      skipped: false,
      key,
      bytes: gz.byteLength,
      sha256,
      pruned: [],
    });

    holder.kill();
    await holder.exited;
    const liveBytes = readFileSync(live);

    const back = await runCli(["restore", "--date", "2026-06-15", "--to", restored], env);
    expect(back.code, back.stderr).toBe(0);
    const body = JSON.parse(back.stdout) as {
      ok: boolean;
      key: string;
      path: string;
      integrity: string;
      boot: string;
      counts: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.key).toBe(key);
    expect(body.path).toBe(restored);
    expect(body.integrity).toBe("ok");
    expect(body.boot).toBe("ok");
    expect(body.counts.visitors).toBe(2);
    expect(body.counts.variants).toBe(1);
    expect(body.counts.events).toBe(3);
    expect(body.counts.sites).toBe(1);
    expect(body.counts.orders).toBe(1);

    const db = new Database(restored, { readonly: true });
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.query("SELECT COUNT(*) AS n FROM visitors").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM variants").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 3 });
    expect(db.query("SELECT COUNT(*) AS n FROM sites").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 1 });
    db.close();

    expect(readFileSync(live)).toEqual(liveBytes);
    const source = new Database(live, { readonly: true });
    expect(source.query("SELECT COUNT(*) AS n FROM visitors").get()).toEqual({ n: 2 });
    source.close();
  },
  { timeout: 90_000 },
);

test.serial(
  "fifteen daily snapshots prune the oldest key and restore of that key fails",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-drill-prune-"));
    const live = join(dir, "ledger.sqlite");
    await writeShop(live);
    const env = childEnv(live);
    await emptyDaily(env);

    const days = Array.from({ length: 15 }, (_, index) => addDays("2026-01-01", index));
    const results: {
      ok: boolean;
      skipped: boolean;
      key: string;
      bytes: number;
      sha256: string;
      pruned: string[];
    }[] = [];
    for (const day of days) {
      const result = await runCli(["snapshot", "--day", day], env);
      expect(result.code, `${day}\n${result.stderr}\n${result.stdout}`).toBe(0);
      results.push(JSON.parse(result.stdout));
    }

    const kept = "prism/daily/2026-01-14.sqlite.gz";
    const keptGzip = await storedGzip(env, kept);
    expect(results[13]).toEqual({
      ok: true,
      skipped: false,
      key: kept,
      bytes: keptGzip.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(keptGzip).digest("hex"),
      pruned: [],
    });

    const key = "prism/daily/2026-01-15.sqlite.gz";
    const gz = await storedGzip(env, key);
    expect(results[14]).toEqual({
      ok: true,
      skipped: false,
      key,
      bytes: gz.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(gz).digest("hex"),
      pruned: ["prism/daily/2026-01-01.sqlite.gz"],
    });

    const restored = join(dir, "ledger-restored.sqlite");
    const missing = await runCli(["restore", "--date", "2026-01-01", "--to", restored], env);
    expect(missing.code, missing.stderr).toBe(1);
    expect(missing.stdout).toBe('{"ok":false,"error":"object not found: prism/daily/2026-01-01.sqlite.gz"}\n');
    expect(existsSync(restored)).toBe(false);
  },
  { timeout: 120_000 },
);

test.serial(
  "snapshot --day in the future does not prune stored dailies",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-drill-future-"));
    const live = join(dir, "shop.sqlite");
    await writeShop(live);
    const env = childEnv(live);
    await emptyDaily(env);

    const snap = await runCli(["snapshot", "--day", "2026-06-15"], env);
    expect(snap.code, snap.stderr).toBe(0);
    const key = "prism/daily/2026-06-15.sqlite.gz";
    const before = await storedGzip(env, key);

    const future = await runCli(["snapshot", "--day", "2099-01-01"], env);
    expect(future.code, future.stderr).toBe(1);
    expect(future.stdout).toBe('{"ok":false,"error":"--day must not be in the future"}\n');

    const after = await storedGzip(env, key);
    expect(after).toEqual(before);
  },
  { timeout: 30_000 },
);
