import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
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
      counts: Record<string, number>;
    }
  | { ok: false; error: string };

export type AdoptResult =
  | { ok: true; adopted: false }
  | { ok: true; adopted: true; path: string }
  | { ok: false; error: string };

type AdoptClass =
  | { kind: "clear" }
  | { kind: "pending"; pending: string; live: string | null }
  | { kind: "aside"; pending: string; previous: string }
  | { kind: "missing-pending"; previous: string }
  | { kind: "leftover"; previous: string; live: string };

type CliResult = SnapshotResult | RestoreResult | AdoptResult;

const STORAGE_FIELDS = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const TIGRIS_HOSTS = new Set(["t3.storage.dev", "fly.storage.tigris.dev"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RETENTION = /^(?:[1-9]|[12]\d|30)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAILY_KEY = /^prism\/daily\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/;
const GZIP_CAP = 32 * 1024 * 1024;
const BUSY_TIMEOUT_MS = 8000;
const PREFIX = "prism/daily/";

const inflight = new Map<string, Promise<Response>>();

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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

function refuseTarget(to: string, env: typeof process.env): string | undefined {
  if (to.trim() === "") return "restore requires --to";
  const dbPath = env.DB_PATH || "prism.db";
  if (resolve(to) === resolve(dbPath)) return "refusing to write DB_PATH";
  if (basename(to) === "prism.db") return "refusing to write prism.db";
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
    const counts = tableCounts(sqlitePath);
    mkdirSync(dirname(resolve(input.to)), { recursive: true });
    await Bun.write(partial, raw);
    renameSync(partial, input.to);
    return { ok: true, key, path: input.to, integrity: "ok", counts };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    rmSync(partial, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

function unlinkSidecars(live: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${live}${suffix}`;
    if (isFile(path)) unlinkSync(path);
  }
}

function pathsFor(dbPath: string): { live: string; pending: string; previous: string } {
  return {
    live: dbPath,
    pending: join(dirname(dbPath), "prism.restore"),
    previous: `${dbPath}.previous`,
  };
}

function classifyAdopt(dbPath: string): AdoptClass {
  const { live, pending, previous } = pathsFor(dbPath);
  const hasPending = isFile(pending);
  const hasPrevious = isFile(previous);
  const hasLive = isFile(live);
  if (hasPending && hasPrevious && !hasLive) return { kind: "aside", pending, previous };
  if (hasPending) return { kind: "pending", pending, live: hasLive ? live : null };
  if (hasPrevious && !hasLive) return { kind: "missing-pending", previous };
  if (hasPrevious && hasLive) return { kind: "leftover", previous, live };
  return { kind: "clear" };
}

function finishSwap(pending: string, previous: string, live: string): AdoptResult {
  let integrity: string;
  try {
    integrity = integrityOf(pending);
  } catch (err) {
    if (isFile(previous) && !isFile(live)) renameSync(previous, live);
    return { ok: false, error: errorMessage(err) };
  }
  if (integrity !== "ok") {
    if (isFile(previous) && !isFile(live)) renameSync(previous, live);
    return { ok: false, error: `integrity_check returned ${integrity}` };
  }
  unlinkSidecars(live);
  renameSync(pending, live);
  if (isFile(previous)) unlinkSync(previous);
  return { ok: true, adopted: true, path: live };
}

function adoptClassified(dbPath: string): AdoptResult {
  const state = classifyAdopt(dbPath);
  switch (state.kind) {
    case "clear":
      return { ok: true, adopted: false };
    case "leftover":
      unlinkSync(state.previous);
      return { ok: true, adopted: false };
    case "missing-pending":
      renameSync(state.previous, dbPath);
      return { ok: false, error: "restore incomplete; moved the previous database back" };
    case "pending": {
      const previous = `${dbPath}.previous`;
      try {
        const integrity = integrityOf(state.pending);
        if (integrity !== "ok") return { ok: false, error: `integrity_check returned ${integrity}` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
      if (isFile(previous)) return { ok: false, error: `${basename(previous)} already exists` };
      if (state.live !== null) renameSync(state.live, previous);
      return finishSwap(state.pending, previous, dbPath);
    }
    case "aside":
      return finishSwap(state.pending, state.previous, dbPath);
    default: {
      const never: never = state;
      return never;
    }
  }
}

export function adopt(input: { dbPath: string }): AdoptResult {
  try {
    return adoptClassified(input.dbPath);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
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

async function runSnapshotChild(env: typeof process.env, day: string): Promise<Response> {
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
  return Response.json(childBody(stdout), { status: code === 0 ? 200 : 500 });
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
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = runSnapshotChild(env, day)
    .catch((err: unknown) => Response.json({ ok: false, error: errorMessage(err) }, { status: 500 }))
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
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
  if (command === "adopt") {
    const result = adopt({ dbPath: env.DB_PATH || "prism.db" });
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
