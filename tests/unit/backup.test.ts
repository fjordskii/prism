import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("backup.ts does not import db, open-db, server, seed, or access", () => {
  const source = readFileSync(join(repo, "src/backup.ts"), "utf8");
  for (const name of ["db", "open-db", "server", "seed", "access"]) {
    expect(source).not.toMatch(new RegExp(String.raw`(?:from|import\(|require\()\s*["']\./${name}(?:\.ts)?["']`));
  }
});

test("VACUUM INTO on a readonly connection copies the file and leaves the source readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-vacuum-"));
  const src = join(dir, "src.sqlite");
  const dest = join(dir, "copy.sqlite");
  const live = new Database(src);
  live.exec("CREATE TABLE visitors (id INTEGER PRIMARY KEY)");
  live.run("INSERT INTO visitors (id) VALUES (1)");
  live.close();

  const readonly = new Database(src, { readonly: true });
  readonly.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  readonly.close();

  const copy = new Database(dest, { readonly: true });
  expect(copy.query("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).toEqual({ n: 1 });
  copy.close();
  const source = new Database(src, { readonly: true });
  expect(source.query("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).toEqual({ n: 1 });
  source.close();
});

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

test("a valid endpoint with the other storage fields unset fails", async () => {
  const result = await runCli(
    ["snapshot", "--day", "2026-10-15"],
    baseEnv({ S3_ENDPOINT: "http://127.0.0.1:9", DB_PATH: join(tmpdir(), "absent.sqlite") }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe(
    '{"ok":false,"error":"missing S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}\n',
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

test("snapshot --day in the future fails before touching storage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-future-day-"));
  const dbPath = join(dir, "live.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE visitors (id INTEGER PRIMARY KEY)");
  db.run("INSERT INTO visitors (id) VALUES (1)");
  db.close();
  const result = await runCli(
    ["snapshot", "--day", "2099-01-01"],
    baseEnv({ ...storage, DB_PATH: dbPath }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"--day must not be in the future"}\n');
  expect(existsSync(dbPath)).toBe(true);
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

test("restore refuses live sidecars, a hardlink, a symlink, and PRISM.DB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-family-"));
  const live = join(dir, "live.sqlite");
  writeFileSync(live, "keep");
  const env = baseEnv({ ...storage, DB_PATH: live });

  for (const suffix of ["-wal", "-shm", "-journal", ".previous"]) {
    const target = `${live}${suffix}`;
    writeFileSync(target, "sidecar");
    const result = await runCli(["restore", "--to", target], env);
    expect(result.code, `${suffix}\n${result.stderr}`).toBe(1);
    expect(result.stdout).toBe('{"ok":false,"error":"refusing to write a live database file"}\n');
    expect(readFileSync(target, "utf8")).toBe("sidecar");
  }

  const foldedWal = join(dir, "LIVE.SQLITE-WAL");
  writeFileSync(foldedWal, "folded");
  const folded = await runCli(["restore", "--to", foldedWal], env);
  expect(folded.code, folded.stderr).toBe(1);
  expect(folded.stdout).toBe('{"ok":false,"error":"refusing to write a live database file"}\n');
  expect(readFileSync(foldedWal, "utf8")).toBe("folded");

  const linked = join(dir, "alias.sqlite");
  linkSync(live, linked);
  const hard = await runCli(["restore", "--to", linked], env);
  expect(hard.code, hard.stderr).toBe(1);
  expect(hard.stdout).toBe('{"ok":false,"error":"refusing to write DB_PATH"}\n');
  expect(readFileSync(live, "utf8")).toBe("keep");

  const named = join(dir, "other.sqlite");
  symlinkSync(live, named);
  const sym = await runCli(["restore", "--to", named], env);
  expect(sym.code, sym.stderr).toBe(1);
  expect(sym.stdout).toBe('{"ok":false,"error":"refusing to write DB_PATH"}\n');
  expect(readFileSync(live, "utf8")).toBe("keep");

  const cased = join(dir, "PRISM.DB");
  writeFileSync(cased, "keep-case");
  const byName = await runCli(["restore", "--to", cased], env);
  expect(byName.code, byName.stderr).toBe(1);
  expect(byName.stdout).toBe('{"ok":false,"error":"refusing to write prism.db"}\n');
  expect(readFileSync(cased, "utf8")).toBe("keep-case");

  unlinkSync(`${live}-journal`);
  const dangling = join(dir, "dangle-journal");
  symlinkSync(`${live}-journal`, dangling);
  const dangle = await runCli(["restore", "--to", dangling], env);
  expect(dangle.code, dangle.stderr).toBe(1);
  expect(dangle.stdout).toBe('{"ok":false,"error":"refusing to write a live database file"}\n');
  expect(existsSync(`${live}-journal`)).toBe(false);
  expect(readFileSync(live, "utf8")).toBe("keep");
});

test("restore to the live WAL refuses and leaves a writer-held database readable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-wal-"));
  const live = join(dir, "prism.db");
  const db = new Database(live);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec("CREATE TABLE visitors (id INTEGER PRIMARY KEY)");
  db.run("INSERT INTO visitors (id) VALUES (1)");
  expect(existsSync(`${live}-wal`)).toBe(true);

  const result = await runCli(
    ["restore", "--to", `${live}-wal`],
    baseEnv({ ...storage, DB_PATH: live }),
  );
  expect(result.code, result.stderr).toBe(1);
  expect(result.stdout).toBe('{"ok":false,"error":"refusing to write a live database file"}\n');

  const fresh = new Database(live);
  expect(fresh.query("SELECT COUNT(*) AS n FROM visitors").get()).toEqual({ n: 1 });
  fresh.close();
  db.close();
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

test("a matching token with a partial S3 config is HTTP 500", async () => {
  const response = await handleBackupRequest(
    new Request("http://127.0.0.1/internal/backup", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    baseEnv({ BACKUP_TOKEN: "secret", S3_ENDPOINT: "http://127.0.0.1:9" }),
    new Date("2026-10-15T08:15:00.000Z"),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    ok: false,
    error: "missing S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
  });
});

test("two concurrent POSTs each own a readable 200 body", async () => {
  const env = baseEnv({ BACKUP_TOKEN: "secret" });
  const now = new Date("2026-10-15T08:15:00.000Z");
  const request = () =>
    handleBackupRequest(
      new Request("http://127.0.0.1/internal/backup", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
      env,
      now,
    );
  const [first, second] = await Promise.all([request(), request()]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const skip = {
    ok: true,
    skipped: true,
    reason: "missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
  };
  expect(await first.json()).toEqual(skip);
  expect(await second.json()).toEqual(skip);
});
