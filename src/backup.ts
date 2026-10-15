import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DailyKey = string & { readonly __brand: "DailyKey" };

type RetentionDays = number & { readonly __brand: "RetentionDays" };

type BackupConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  retentionDays: RetentionDays;
};

type ConfigRead =
  | { ok: true; config: BackupConfig }
  | { ok: false; kind: "missing"; reason: string }
  | { ok: false; kind: "invalid"; error: string };

export type SnapshotResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped: false;
      key: DailyKey;
      bytes: number;
      sha256: string;
      pruned: DailyKey[];
    }
  | { ok: false; error: string };

export type RestoreResult =
  | {
      ok: true;
      key: DailyKey;
      path: string;
      integrity: "ok";
      boot: "ok";
      counts: Record<string, number>;
    }
  | { ok: false; error: string };

export type KeepResult =
  | { ok: true; path: string; counts: Record<string, number> }
  | { ok: false; error: string };

type CliResult = SnapshotResult | RestoreResult | KeepResult;

const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  visitors: ["id", "site", "first_seen", "last_seen", "visits"],
  variants: ["id", "site", "name", "selector", "ops", "audience", "created_at"],
  events: ["id", "site", "visitor_id", "variant_id", "selector", "type", "ts"],
  sites: ["site", "plan", "created_at"],
};

const STORAGE_FIELDS = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const TIGRIS_HOSTS = new Set(["t3.storage.dev", "fly.storage.tigris.dev"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RETENTION = /^(?:[1-9]|[12]\d|30)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAILY_KEY = /^prism\/daily\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/;
const GZIP_CAP = 32 * 1024 * 1024;
const BUSY_TIMEOUT_MS = 8000;
const PROVE_TIMEOUT_MS = 60_000;
const PROVE_KILL_GRACE_MS = 2_000;
const PREFIX = "prism/daily/";
const LIVE_SIDECARS = ["-wal", "-shm", "-journal", ".previous"] as const;

type SnapshotReceipt = { status: number; body: unknown };

const inflight = new Map<string, Promise<SnapshotReceipt>>();

function envValue(env: typeof process.env, name: string): string {
  const value = env[name];
  return value === undefined ? "" : value.trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function readConfig(env: typeof process.env): ConfigRead {
  const endpoint = envValue(env, "S3_ENDPOINT");
  const bucket = envValue(env, "S3_BUCKET");
  const accessKeyId = envValue(env, "S3_ACCESS_KEY_ID");
  const secretAccessKey = envValue(env, "S3_SECRET_ACCESS_KEY");
  const region = envValue(env, "S3_REGION");
  const retentionRaw = envValue(env, "BACKUP_RETENTION_DAYS");

  const invalid: string[] = [];
  if (endpoint !== "" && !isHttpUrl(endpoint)) invalid.push("S3_ENDPOINT is not a URL");
  if (bucket !== "" && !DNS_LABEL.test(bucket)) invalid.push("S3_BUCKET is not one DNS label");
  if (retentionRaw !== "" && !RETENTION.test(retentionRaw)) {
    invalid.push("BACKUP_RETENTION_DAYS is not an integer from 1 to 30");
  }
  if (invalid.length > 0) return { ok: false, kind: "invalid", error: invalid.join("; ") };

  const missing = STORAGE_FIELDS.filter((name) => envValue(env, name) === "");
  const present = STORAGE_FIELDS.length - missing.length;
  if (present > 0 && missing.length > 0) {
    return { ok: false, kind: "invalid", error: `missing ${missing.join(", ")}` };
  }
  if (missing.length > 0) return { ok: false, kind: "missing", reason: `missing ${missing.join(", ")}` };

  const retention = Number(retentionRaw === "" ? "14" : retentionRaw) as RetentionDays;
  return {
    ok: true,
    config: {
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: region === "" ? "auto" : region,
      retentionDays: retention,
    },
  };
}

function configFailure(read: Extract<ConfigRead, { ok: false }>): SnapshotResult {
  if (read.kind === "missing") return { ok: true, skipped: true, reason: read.reason };
  return { ok: false, error: read.error };
}

function clientFor(config: BackupConfig): Bun.S3Client {
  const url = new URL(config.endpoint);
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  };
  // Bun drops `bucket` when virtualHostedStyle is on and an endpoint is set, so the bucket has to be in the host.
  if (TIGRIS_HOSTS.has(url.hostname)) {
    const port = url.port === "" ? "" : `:${url.port}`;
    return new Bun.S3Client({
      ...credentials,
      endpoint: `${url.protocol}//${config.bucket}.${url.hostname}${port}`,
      virtualHostedStyle: true,
    });
  }
  return new Bun.S3Client({
    ...credentials,
    endpoint: config.endpoint,
    bucket: config.bucket,
    virtualHostedStyle: false,
  });
}

function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  return typeof err.code === "string" ? err.code : "";
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "snapshot process failed";
  const code = errorCode(err);
  const text = (code === "" ? message : `${code}: ${message}`).replace(/\s+/g, " ").trim();
  if (text === "") return "snapshot process failed";
  return text.length > 300 ? text.slice(0, 300) : text;
}

function isMissingObject(err: unknown): boolean {
  const code = errorCode(err);
  if (code === "NoSuchKey" || code === "NotFound") return true;
  const message = err instanceof Error ? err.message : "";
  return /NoSuchKey|Not Found/.test(message);
}

function parseDay(value: string): string | undefined {
  const match = DAY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return value;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const match = DAY.exec(day);
  if (!match) throw new Error("--day must be YYYY-MM-DD");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta));
  return date.toISOString().slice(0, 10);
}

function asDailyKey(key: string): DailyKey | undefined {
  const match = DAILY_KEY.exec(key);
  if (!match || match[1] === undefined || parseDay(match[1]) === undefined) return undefined;
  return key as DailyKey;
}

function dailyKeyForDay(day: string): DailyKey {
  const key = asDailyKey(`${PREFIX}${day}.sqlite.gz`);
  if (!key) throw new Error("--day must be YYYY-MM-DD");
  return key;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function field(row: unknown, name: string): unknown {
  if (typeof row !== "object" || row === null || !(name in row)) return undefined;
  return row[name as keyof typeof row];
}

function integrityOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const messages: string[] = [];
    for (const row of db.query("PRAGMA integrity_check").all()) {
      const value = field(row, "integrity_check");
      if (typeof value === "string") messages.push(value);
    }
    if (messages.length === 1 && messages[0] === "ok") return "ok";
    return messages.join("; ") || "empty";
  } finally {
    db.close();
  }
}

export function schemaError(path: string): string | undefined {
  try {
    if (statSync(path).size === 0) return "empty database";
  } catch (err) {
    return errorMessage(err);
  }
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (err) {
    return errorMessage(err);
  }
  try {
    const missing: string[] = [];
    for (const [table, cols] of Object.entries(REQUIRED_SCHEMA)) {
      const info = db.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
      if (info.length === 0) {
        missing.push(table);
        continue;
      }
      const have = new Set(info.map((col) => col.name));
      for (const col of cols) {
        if (!have.has(col)) missing.push(`${table}.${col}`);
      }
    }
    if (missing.length > 0) return `missing schema: ${missing.join(", ")}`;
    return undefined;
  } finally {
    db.close();
  }
}

function tableCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const counts: Record<string, number> = {};
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const row of rows) {
      const name = field(row, "name");
      if (typeof name !== "string") continue;
      const countRow = db.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get();
      const n = field(countRow, "n");
      if (typeof n !== "number") throw new Error(`count failed for ${name}`);
      counts[name] = n;
    }
    return counts;
  } finally {
    db.close();
  }
}

function vacuumInto(dbPath: string, dest: string): void {
  if (statExists(dest)) throw new Error("vacuum destination already exists");
  // query_only rejects VACUUM INTO. A readonly connection still runs it and leaves the source file unchanged.
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(`VACUUM INTO ${sqlString(dest)}`);
  } finally {
    db.close();
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function keysToDelete(keys: readonly string[], today: string, retentionDays: RetentionDays): DailyKey[] {
  const cutoff = shiftDay(today, -(retentionDays - 1));
  const doomed: DailyKey[] = [];
  for (const key of keys) {
    const daily = asDailyKey(key);
    if (!daily) continue;
    const day = daily.slice(PREFIX.length, PREFIX.length + 10);
    if (day < cutoff) doomed.push(daily);
  }
  doomed.sort();
  return doomed;
}

async function listKeys(client: Bun.S3Client): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const listed = await client.list({
      prefix: PREFIX,
      maxKeys: 1000,
      ...(continuationToken ? { continuationToken } : {}),
    });
    for (const item of listed.contents ?? []) keys.push(item.key);
    if (!listed.isTruncated) return keys;
    const next = listed.nextContinuationToken;
    if (next === undefined || next === continuationToken) break;
    continuationToken = next;
  }
  throw new Error("object list did not finish");
}

async function prune(client: Bun.S3Client, today: string, retentionDays: RetentionDays): Promise<DailyKey[]> {
  const doomed = keysToDelete(await listKeys(client), today, retentionDays);
  for (const key of doomed) {
    try {
      await client.file(key).delete();
    } catch (err) {
      if (!isMissingObject(err)) throw err;
    }
  }
  return doomed;
}

export async function snapshot(input: {
  env: typeof process.env;
  dbPath: string;
  now: Date;
}): Promise<SnapshotResult> {
  const read = readConfig(input.env);
  if (!read.ok) return configFailure(read);
  const day = utcDay(input.now);
  if (parseDay(day) === undefined) return { ok: false, error: "--day must be YYYY-MM-DD" };
  if (day > utcDay(new Date())) return { ok: false, error: "--day must not be in the future" };
  const key = dailyKeyForDay(day);
  const work = mkdtemp(join(tmpdir(), "prism-backup-"));
  const vacuumPath = join(work, "vacuum.sqlite");
  const gzipPath = join(work, "snapshot.sqlite.gz");
  try {
    vacuumInto(input.dbPath, vacuumPath);
    const integrity = integrityOf(vacuumPath);
    if (integrity !== "ok") return { ok: false, error: `integrity_check returned ${integrity}` };
    const raw = await Bun.file(vacuumPath).bytes();
    const gz = Bun.gzipSync(raw);
    if (gz.byteLength > GZIP_CAP) return { ok: false, error: "gzip exceeds 32 MiB" };
    const sha256 = new Bun.CryptoHasher("sha256").update(gz).digest("hex");
    await Bun.write(gzipPath, gz);
    const client = clientFor(read.config);
    await client.file(key).write(Bun.file(gzipPath));
    const pruned = await prune(client, day, read.config.retentionDays);
    return { ok: true, skipped: false, key, bytes: gz.byteLength, sha256, pruned };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function mkdtemp(prefix: string): string {
  return mkdtempSync(prefix);
}

function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

function foldPath(path: string): string {
  return canonicalPath(path).normalize("NFC").toLowerCase();
}

function sameInode(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function linkedTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

function sameLiveFile(to: string, member: string): boolean {
  if (sameInode(to, member)) return true;
  if (foldPath(to) === foldPath(member)) return true;
  const linked = linkedTarget(to);
  if (linked === undefined) return false;
  if (sameInode(linked, member)) return true;
  return foldPath(linked) === foldPath(member);
}

function isGenerationPath(to: string, dbPath: string): boolean {
  const live = foldPath(dbPath);
  const paths = [foldPath(to)];
  const linked = linkedTarget(to);
  if (linked !== undefined) paths.push(foldPath(linked));
  for (const path of paths) {
    if (path === `${live}.previous` || path.startsWith(`${live}.previous.`)) return true;
  }
  return false;
}

function refuseTarget(to: string, env: typeof process.env): string | undefined {
  if (to.trim() === "") return "restore requires --to";
  const dbPath = env.DB_PATH || "prism.db";
  if (sameLiveFile(to, dbPath)) return "refusing to write DB_PATH";
  for (const suffix of LIVE_SIDECARS) {
    if (sameLiveFile(to, `${dbPath}${suffix}`)) return "refusing to write a live database file";
  }
  if (isGenerationPath(to, dbPath)) return "refusing to write a live database file";
  if (basename(to).normalize("NFC").toLowerCase() === "prism.db") return "refusing to write prism.db";
  return undefined;
}

async function newestDailyKey(client: Bun.S3Client): Promise<DailyKey | undefined> {
  let best: DailyKey | undefined;
  let bestDay = "";
  for (const key of await listKeys(client)) {
    const daily = asDailyKey(key);
    if (!daily) continue;
    const day = daily.slice(PREFIX.length, PREFIX.length + 10);
    if (day > bestDay) {
      best = daily;
      bestDay = day;
    }
  }
  return best;
}

function proveEnv(env: typeof process.env, dbPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  out.DB_PATH = dbPath;
  return out;
}

export async function proveStartup(dbPath: string, env: typeof process.env = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  const schema = schemaError(dbPath);
  if (schema !== undefined) return { ok: false, error: schema };
  const script = join(dirname(fileURLToPath(import.meta.url)), "prove-boot.ts");
  const child = Bun.spawn([process.execPath, script, dbPath], {
    cwd: dirname(dirname(script)),
    env: proveEnv(env, dbPath),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already have exited.
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may already have exited.
      }
    }, PROVE_KILL_GRACE_MS);
  }, PROVE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) return { ok: false, error: "startup timed out" };
    if (code === 0) return { ok: true };
    const text = `${stderr}\n${stdout}`.replace(/\s+/g, " ").trim();
    return { ok: false, error: text === "" ? "startup failed" : text.slice(0, 500) };
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }
}

export async function restore(input: {
  env: typeof process.env;
  date: string | null;
  to: string;
}): Promise<RestoreResult> {
  const refused = refuseTarget(input.to, input.env);
  if (refused) return { ok: false, error: refused };
  const read = readConfig(input.env);
  if (!read.ok) return { ok: false, error: read.kind === "missing" ? read.reason : read.error };
  if (input.date !== null && parseDay(input.date) === undefined) return { ok: false, error: "--date must be YYYY-MM-DD" };

  const client = clientFor(read.config);
  const work = mkdtemp(join(tmpdir(), "prism-restore-"));
  const partial = join(dirname(input.to), `.${basename(input.to)}.partial`);
  try {
    const key = input.date === null ? await newestDailyKey(client) : dailyKeyForDay(input.date);
    if (key === undefined) return { ok: false, error: "no snapshots" };
    let gz: Uint8Array;
    try {
      gz = new Uint8Array(await client.file(key).arrayBuffer());
    } catch (err) {
      if (isMissingObject(err)) return { ok: false, error: `object not found: ${key}` };
      throw err;
    }
    let raw: Uint8Array;
    try {
      raw = Bun.gunzipSync(gz);
    } catch {
      return { ok: false, error: "object is not gzip" };
    }
    const sqlitePath = join(work, "restored.sqlite");
    await Bun.write(sqlitePath, raw);
    const integrity = integrityOf(sqlitePath);
    if (integrity !== "ok") return { ok: false, error: `integrity_check returned ${integrity}` };
    const schema = schemaError(sqlitePath);
    if (schema !== undefined) return { ok: false, error: schema };
    const counts = tableCounts(sqlitePath);
    const proveCopy = join(work, "prove.sqlite");
    copyFileSync(sqlitePath, proveCopy);
    const proved = await proveStartup(proveCopy, input.env);
    if (!proved.ok) return { ok: false, error: proved.error };
    mkdirSync(dirname(resolve(input.to)), { recursive: true });
    await Bun.write(partial, raw);
    renameSync(partial, input.to);
    return { ok: true, key, path: input.to, integrity: "ok", boot: "ok", counts };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    rmSync(partial, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

function sha256Equal(expected: string, presented: string): boolean {
  const left = new Bun.CryptoHasher("sha256").update(expected).digest();
  const right = new Bun.CryptoHasher("sha256").update(presented).digest();
  return timingSafeEqual(left, right);
}

function childEnv(env: typeof process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function childBody(stdout: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    return { ok: false, error: "snapshot process failed" };
  }
  return { ok: false, error: "snapshot process failed" };
}

async function runSnapshotChild(env: typeof process.env, day: string): Promise<SnapshotReceipt> {
  const script = fileURLToPath(import.meta.url);
  const child = Bun.spawn([process.execPath, script, "snapshot", "--day", day], {
    cwd: dirname(dirname(script)),
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { status: code === 0 ? 200 : 500, body: childBody(stdout) };
}

export function keep(input: {
  env: typeof process.env;
  dbPath: string;
  to: string;
}): KeepResult {
  const refused = refuseTarget(input.to, input.env);
  if (refused) return { ok: false, error: refused };
  if (statExists(input.to)) return { ok: false, error: "keep destination already exists" };
  try {
    mkdirSync(dirname(resolve(input.to)), { recursive: true });
    vacuumInto(input.dbPath, input.to);
    return { ok: true, path: input.to, counts: tableCounts(input.to) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function handleBackupRequest(req: Request, env: typeof process.env, now: Date): Promise<Response> {
  if (env.BACKUP_TOKEN === undefined || env.BACKUP_TOKEN === "") {
    return Promise.resolve(Response.json({ ok: false, error: "BACKUP_TOKEN is unset" }, { status: 401 }));
  }
  if (!sha256Equal(env.BACKUP_TOKEN, bearer(req))) {
    return Promise.resolve(Response.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  }
  const day = utcDay(now);
  const key = `${PREFIX}${day}.sqlite.gz`;
  let work = inflight.get(key);
  if (work === undefined) {
    work = runSnapshotChild(env, day)
      .catch((err: unknown): SnapshotReceipt => ({
        status: 500,
        body: { ok: false, error: errorMessage(err) },
      }))
      .finally(() => {
        if (inflight.get(key) === work) inflight.delete(key);
      });
    inflight.set(key, work);
  }
  return work.then(({ status, body }) => Response.json(body, { status }));
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return "";
  return value;
}

function writeResult(value: CliResult): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(argv: readonly string[], env: typeof process.env): Promise<number> {
  const command = argv[0];
  if (command === "snapshot") {
    let now = new Date();
    const day = flag(argv, "--day");
    if (day !== undefined) {
      if (parseDay(day) === undefined) {
        writeResult({ ok: false, error: "--day must be YYYY-MM-DD" });
        return 1;
      }
      now = new Date(`${day}T12:00:00.000Z`);
    }
    const result = await snapshot({ env, dbPath: env.DB_PATH || "prism.db", now });
    writeResult(result);
    return result.ok ? 0 : 1;
  }
  if (command === "restore") {
    const dateFlag = flag(argv, "--date");
    const to = flag(argv, "--to");
    if (to === undefined || to === "") {
      writeResult({ ok: false, error: "restore requires --to" });
      return 1;
    }
    if (dateFlag !== undefined && parseDay(dateFlag) === undefined) {
      writeResult({ ok: false, error: "--date must be YYYY-MM-DD" });
      return 1;
    }
    const result = await restore({ env, date: dateFlag === undefined ? null : dateFlag, to });
    writeResult(result);
    return result.ok ? 0 : 1;
  }
  if (command === "keep") {
    const to = flag(argv, "--to");
    if (to === undefined || to === "") {
      writeResult({ ok: false, error: "keep requires --to" });
      return 1;
    }
    const result = keep({ env, dbPath: env.DB_PATH || "prism.db", to });
    writeResult(result);
    return result.ok ? 0 : 1;
  }
  writeResult({ ok: false, error: "unknown command" });
  return 1;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2), process.env);
  } catch (err) {
    writeResult({ ok: false, error: errorMessage(err) });
  }
  process.exit(code);
}
