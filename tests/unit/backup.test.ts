import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBackupRequest } from "../../src/backup";

const repo = join(import.meta.dir, "../..");

const MISSING =
  '{"ok":true,"skipped":true,"reason":"missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}\n';

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("AWS_") || key.startsWith("S3_")) continue;
    if (key === "BACKUP_RETENTION_DAYS" || key === "BACKUP_TOKEN") continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

async function runCli(args: string[], env: Record<string, string>, cwd = repo) {
  const proc = Bun.spawn(["bun", "src/backup.ts", ...args], {
    cwd,
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

const storage = {
  S3_ENDPOINT: "http://127.0.0.1:9",
  S3_BUCKET: "prism-drill",
  S3_ACCESS_KEY_ID: "drill-key",
  S3_SECRET_ACCESS_KEY: "drill-secret",
};

test("snapshot with no S3 env exits 0 and prints the skip receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-skip-"));
  const result = await runCli(["snapshot"], baseEnv({ DB_PATH: join(dir, "absent.sqlite") }));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(MISSING);
});

test("whitespace-only S3 env is the same skip", async () => {
  const result = await runCli(
    ["snapshot"],
    baseEnv({
      S3_ENDPOINT: "   ",
      S3_BUCKET: " ",
      S3_ACCESS_KEY_ID: " ",
      S3_SECRET_ACCESS_KEY: " ",
      DB_PATH: join(mkdtempSync(join(tmpdir(), "prism-backup-ws-")), "absent.sqlite"),
    }),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(MISSING);
});

test("a valid endpoint with the other storage fields unset still skips", async () => {
  const result = await runCli(
    ["snapshot", "--day", "2026-10-15"],
    baseEnv({ S3_ENDPOINT: "http://127.0.0.1:9", DB_PATH: join(tmpdir(), "absent.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    '{"ok":true,"skipped":true,"reason":"missing S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}\n',
  );
});

test("a present S3_ENDPOINT that is not a URL fails the snapshot", async () => {
  const result = await runCli(
    ["snapshot"],
    baseEnv({ ...storage, S3_ENDPOINT: "not-a-url", DB_PATH: join(tmpdir(), "absent.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"S3_ENDPOINT is not a URL"}\n');
});

test("a bucket that is not one DNS label fails the snapshot", async () => {
  const result = await runCli(
    ["snapshot"],
    baseEnv({ ...storage, S3_BUCKET: "not a bucket", DB_PATH: join(tmpdir(), "absent.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"S3_BUCKET is not one DNS label"}\n');
});

test("BACKUP_RETENTION_DAYS outside 1 to 30 fails the snapshot", async () => {
  for (const value of ["0", "31", "14.5"]) {
    const result = await runCli(
      ["snapshot"],
      baseEnv({ ...storage, BACKUP_RETENTION_DAYS: value, DB_PATH: join(tmpdir(), "absent.sqlite") }),
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe('{"ok":false,"error":"BACKUP_RETENTION_DAYS is not an integer from 1 to 30"}\n');
  }
});

test("an invalid field fails even when another storage field is missing", async () => {
  const result = await runCli(
    ["snapshot"],
    baseEnv({ S3_ENDPOINT: "not-a-url", DB_PATH: join(tmpdir(), "absent.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"S3_ENDPOINT is not a URL"}\n');
});

test("snapshot --day rejects a calendar date that does not exist", async () => {
  const result = await runCli(["snapshot", "--day", "2026-02-31"], baseEnv());
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"--day must be YYYY-MM-DD"}\n');
});

test("a configured snapshot of a missing database reports SQLite and does not upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-missing-db-"));
  const result = await runCli(["snapshot"], baseEnv({ ...storage, DB_PATH: join(dir, "absent.sqlite") }));
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"SQLITE_CANTOPEN: unable to open database file"}\n');
});

test("a configured snapshot vacuums and attempts a path-style PUT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-put-"));
  const dbPath = join(dir, "live.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE visitors (id INTEGER PRIMARY KEY)");
  db.run("INSERT INTO visitors (id) VALUES (1)");
  db.close();
  const result = await runCli(["snapshot", "--day", "2026-10-15"], baseEnv({ ...storage, DB_PATH: dbPath }));
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"ConnectionRefused: an unexpected error has occurred"}\n');
  expect(existsSync(dbPath)).toBe(true);
});

test("restore refuses to write DB_PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-refuse-"));
  const live = join(dir, "live.sqlite");
  writeFileSync(live, "keep");
  const result = await runCli(["restore", "--to", live], baseEnv({ ...storage, DB_PATH: live }));
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"refusing to write DB_PATH"}\n');
  expect(readFileSync(live, "utf8")).toBe("keep");
});

test("restore refuses a target named prism.db", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-name-"));
  const target = join(dir, "prism.db");
  writeFileSync(target, "keep");
  const result = await runCli(
    ["restore", "--date", "2026-10-15", "--to", target],
    baseEnv({ ...storage, DB_PATH: join(dir, "live.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"refusing to write prism.db"}\n');
  expect(readFileSync(target, "utf8")).toBe("keep");
});

test("restore with storage env unset fails and leaves the target untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-restore-skip-"));
  const target = join(dir, "out.sqlite");
  writeFileSync(target, "keep");
  const result = await runCli(["restore", "--to", target], baseEnv({ DB_PATH: join(dir, "live.sqlite") }));
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe(
    '{"ok":false,"error":"missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}\n',
  );
  expect(readFileSync(target, "utf8")).toBe("keep");
});

test("restore of a configured key leaves the target untouched when the endpoint refuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-restore-down-"));
  const target = join(dir, "out.sqlite");
  writeFileSync(target, "keep");
  const result = await runCli(
    ["restore", "--date", "2026-10-14", "--to", target],
    baseEnv({ ...storage, DB_PATH: join(dir, "live.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"ConnectionRefused: an unexpected error has occurred"}\n');
  expect(readFileSync(target, "utf8")).toBe("keep");
});

test("BACKUP_TOKEN unset or wrong is HTTP 401", async () => {
  const unset = await handleBackupRequest(
    new Request("http://127.0.0.1/internal/backup", { method: "POST" }),
    {},
    new Date("2026-10-15T08:15:00.000Z"),
  );
  expect(unset.status).toBe(401);
  expect(await unset.json()).toEqual({ ok: false, error: "BACKUP_TOKEN is unset" });

  const wrong = await handleBackupRequest(
    new Request("http://127.0.0.1/internal/backup", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    }),
    { BACKUP_TOKEN: "secret" },
    new Date("2026-10-15T08:15:00.000Z"),
  );
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ ok: false, error: "unauthorized" });
});

test("the server route rejects a missing token and the trust pages name Tigris", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-route-"));
  const script = `
    process.env.DB_PATH = ${JSON.stringify(join(dir, "route.sqlite"))};
    delete process.env.BACKUP_TOKEN;
    console.log = () => {};
    const { default: app } = await import("./src/server.ts");
    const backup = await app.request("http://127.0.0.1/internal/backup", { method: "POST" });
    const privacy = await (await app.request("http://127.0.0.1/privacy")).text();
    const security = await (await app.request("http://127.0.0.1/security")).text();
    process.stdout.write(JSON.stringify({ status: backup.status, body: await backup.json(), privacy, security }));
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: repo,
    env: baseEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  const page = JSON.parse(stdout) as { status: number; body: { ok: boolean; error: string }; privacy: string; security: string };
  expect(page.status).toBe(401);
  expect(page.body).toEqual({ ok: false, error: "BACKUP_TOKEN is unset" });
  expect(page.privacy).toContain(
    "Data lives in SQLite on Fly.io (US, iad region). Fly.io keeps daily volume snapshots. When off-volume backup is configured, Prism also stores one gzipped copy per day in Tigris and deletes copies older than 14 days. Tigris is then a subprocessor. Fly.io hosts the app. Contact: privacy@sundaymorning.software.",
  );
  expect(page.privacy).toContain("The saved count has no cookie and no IP address.");
  expect(page.security).toContain(
    "Browser to Prism API (HTTPS only, HSTS via the Fly edge) to SQLite on an encrypted Fly volume. When off-volume backup is configured, the app uploads that database to Tigris. Visitor data does not go anywhere else.",
  );
  expect(page.security).not.toContain("No data leaves that path.");
}, { timeout: 30_000 });

test("a matching token with no S3 env returns the skip receipt", async () => {
  const response = await handleBackupRequest(
    new Request("http://127.0.0.1/internal/backup", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    baseEnv({ BACKUP_TOKEN: "secret" }),
    new Date("2026-10-15T08:15:00.000Z"),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    skipped: true,
    reason: "missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
  });
});
