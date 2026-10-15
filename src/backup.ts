import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, unlinkSync } from "node:fs";
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

type ProveResult =
  | { ok: true }
  | { ok: false; kind: "invalid"; error: string }
  | { ok: false; kind: "env"; error: string };

type CliResult = SnapshotResult | RestoreResult | AdoptResult;

const STORAGE_FIELDS = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const TIGRIS_HOSTS = new Set(["t3.storage.dev", "fly.storage.tigris.dev"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RETENTION = /^(?:[1-9]|[12]\d|30)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAILY_KEY = /^prism\/daily\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/;
const GZIP_CAP = 32 * 1024 * 1024;
const BUSY_TIMEOUT_MS = 8000;
const PROVE_TIMEOUT_MS = 60_000;
const GENERATION_KEEP = 3;
const PREFIX = "prism/daily/";
const LIVE_SIDECARS = ["-wal", "-shm", "-journal", ".previous"] as const;
const DB_SIDECARS = ["-wal", "-shm", "-journal"] as const;

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

function inspectCandidate(path: string): string | undefined {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return "restore file is not a file";
    size = st.size;
  } catch {
    return "restore file is missing";
  }
  if (size === 0) return "restore file is empty";
  let integrity: string;
  try {
    integrity = integrityOf(path);
  } catch (err) {
    return errorMessage(err);
  }
  if (integrity !== "ok") return `integrity_check returned ${integrity}`;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (err) {
    return errorMessage(err);
  }
  try {
    const rows = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
    ).all();
    if (rows.length === 0) return "restore file has no user tables";
    db.query("SELECT COUNT(*) AS n FROM visitors").get();
  } catch (err) {
    return errorMessage(err);
  } finally {
    db.close();
  }
  return undefined;
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

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function pendingPath(dbPath: string): string {
  return join(dirname(dbPath), "prism.restore");
}

function uniqueAside(path: string, label: string): string {
  let dest = `${path}.${label}`;
  if (statExists(dest)) dest = `${path}.${label}.${Date.now()}`;
  return dest;
}

function moveSidecars(from: string, to: string): void {
  for (const suffix of DB_SIDECARS) {
    const src = `${from}${suffix}`;
    if (!isRegularFile(src)) continue;
    renameSync(src, `${to}${suffix}`);
  }
}

function unlinkSidecars(live: string): void {
  for (const suffix of DB_SIDECARS) {
    const path = `${live}${suffix}`;
    if (isRegularFile(path)) unlinkSync(path);
  }
}

function copyDatabase(src: string, dest: string): void {
  copyFileSync(src, dest);
  for (const suffix of DB_SIDECARS) {
    if (isRegularFile(`${src}${suffix}`)) copyFileSync(`${src}${suffix}`, `${dest}${suffix}`);
  }
}

function generationPrefix(live: string): string {
  return `${basename(live)}.previous`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generationStamp(live: string, name: string): number | undefined {
  const prefix = generationPrefix(live);
  if (name === prefix) return 0;
  const match = new RegExp(`^${escapeRe(prefix)}\\.(\\d+)$`).exec(name);
  if (match === null || match[1] === undefined) return undefined;
  return Number(match[1]);
}

function isGenerationName(live: string, name: string): boolean {
  return generationStamp(live, name) !== undefined;
}

function listGenerations(live: string): string[] {
  const dir = dirname(live);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: { path: string; stamp: number }[] = [];
  for (const name of names) {
    const stamp = generationStamp(live, name);
    if (stamp === undefined) continue;
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
    } catch {
      continue;
    }
    found.push({ path, stamp });
  }
  found.sort((a, b) => b.stamp - a.stamp || b.path.localeCompare(a.path));
  return found.map((row) => row.path);
}

function newestGeneration(live: string): string | undefined {
  return listGenerations(live)[0];
}

function pruneGenerations(live: string): void {
  for (const extra of listGenerations(live).slice(GENERATION_KEEP)) {
    unlinkSync(extra);
    unlinkSidecars(extra);
  }
}

function nextGenerationPath(live: string): string {
  let ts = Date.now();
  let dest = `${live}.previous.${ts}`;
  while (statExists(dest)) {
    ts += 1;
    dest = `${live}.previous.${ts}`;
  }
  return dest;
}

function checkpointLive(live: string): void {
  const db = new Database(live);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function displaceLive(live: string): string {
  try {
    checkpointLive(live);
  } catch {
    // WAL sidecars move with the file so the last writes stay on the generation.
  }
  const dest = nextGenerationPath(live);
  renameSync(live, dest);
  moveSidecars(live, dest);
  return dest;
}

function injected(name: string): void {
  if ((process.env.PRISM_ADOPT_INJECT ?? "") !== name) return;
  const err = new Error("no space left on device");
  (err as NodeJS.ErrnoException).code = "ENOSPC";
  throw err;
}

function isEnvError(err: unknown): boolean {
  const code = errorCode(err);
  if (
    code === "ENOSPC" || code === "EDQUOT" || code === "ENOMEM" || code === "EAGAIN"
    || code === "EBUSY" || code === "EIO" || code === "EMFILE" || code === "ENFILE"
    || code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ETIMEDOUT"
  ) {
    return true;
  }
  const text = errorMessage(err);
  return /ENOSPC|EDQUOT|ENOMEM|no space left|disk I\/O error|SQLITE_FULL|SQLITE_IOERR|SQLITE_NOMEM|killed|timed out/i.test(text);
}

function databaseBytes(path: string): number {
  let n = 0;
  try {
    n += lstatSync(path).size;
  } catch {
    return n;
  }
  for (const suffix of DB_SIDECARS) {
    try {
      const st = lstatSync(`${path}${suffix}`);
      if (st.isFile()) n += st.size;
    } catch {
      continue;
    }
  }
  return n;
}

function freeBytes(path: string): number {
  const st = statfsSync(path);
  return Number(st.bavail) * Number(st.bsize);
}

function quarantinePending(pending: string): void {
  const dest = uniqueAside(pending, "rejected");
  renameSync(pending, dest);
  process.stderr.write(`adopt: moved stray restore aside to ${dest}\n`);
}

function quarantineLive(live: string): string {
  const dest = uniqueAside(live, "unbootable");
  renameSync(live, dest);
  moveSidecars(live, dest);
  return dest;
}

function proveEnv(dbPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("AWS_") || key.startsWith("S3_")) continue;
    if (key === "BACKUP_TOKEN") continue;
    out[key] = value;
  }
  out.DB_PATH = dbPath;
  return out;
}

async function runProveBoot(dbPath: string): Promise<ProveResult> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "prove-boot.ts");
  const child = Bun.spawn([process.execPath, script, dbPath], {
    cwd: dirname(dirname(script)),
    env: proveEnv(dbPath),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PROVE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code === 0) return { ok: true };
    const text = `${stderr}\n${stdout}`.replace(/\s+/g, " ").trim();
    const error = text === "" ? "prove-boot failed" : text.slice(0, 500);
    if (
      timedOut || code === null || code < 0 || code === 137 || code === 143
      || /ENOSPC|EDQUOT|ENOMEM|no space left|disk I\/O error|SQLITE_FULL|SQLITE_IOERR|SQLITE_NOMEM|killed|timed out/i.test(error)
    ) {
      return { ok: false, kind: "env", error: timedOut ? `prove-boot timed out: ${error}` : error };
    }
    return { ok: false, kind: "invalid", error };
  } finally {
    clearTimeout(timer);
  }
}

async function proveCandidate(path: string): Promise<ProveResult> {
  try {
    const refused = inspectCandidate(path);
    if (refused !== undefined) return { ok: false, kind: "invalid", error: refused };
  } catch (err) {
    return { ok: false, kind: isEnvError(err) ? "env" : "invalid", error: errorMessage(err) };
  }
  let work: string | undefined;
  try {
    const dir = dirname(resolve(path));
    const needed = databaseBytes(path) + 65_536;
    if (freeBytes(dir) < needed) {
      const err = new Error("no space left on device");
      (err as NodeJS.ErrnoException).code = "ENOSPC";
      throw err;
    }
    work = mkdtemp(join(dir, ".prism-prove-"));
    const copy = join(work, "copy.sqlite");
    injected("enospc-copy");
    copyDatabase(path, copy);
    return await runProveBoot(copy);
  } catch (err) {
    return { ok: false, kind: isEnvError(err) ? "env" : "invalid", error: errorMessage(err) };
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

async function restoreGeneration(live: string, gen: string): Promise<boolean> {
  unlinkSidecars(live);
  if (isRegularFile(live)) unlinkSync(live);
  copyDatabase(gen, live);
  const proved = await proveCandidate(live);
  if (proved.ok) return true;
  if (proved.kind === "env") {
    process.stderr.write(`adopt: prove of restored generation deferred (${proved.error}); leaving copy in place\n`);
    return true;
  }
  if (isRegularFile(live)) {
    const dest = uniqueAside(live, "rejected");
    renameSync(live, dest);
    moveSidecars(live, dest);
  }
  return false;
}

async function ensureLive(live: string): Promise<void> {
  if (isRegularFile(live)) {
    const proved = await proveCandidate(live);
    if (proved.ok) return;
    if (proved.kind === "env") {
      process.stderr.write(`adopt: prove of live deferred (${proved.error}); leaving live in place\n`);
      return;
    }
    const gen = newestGeneration(live);
    process.stderr.write(
      `adopt: live database failed boot${gen === undefined ? "" : `; restoring ${gen}`}: ${proved.error}\n`,
    );
    if (gen === undefined) return;
    const aside = quarantineLive(live);
    try {
      if (!(await restoreGeneration(live, gen))) {
        process.stderr.write(`adopt: newest generation also failed boot: ${gen}\n`);
      }
    } catch (err) {
      undoDisplace(live, aside);
      throw err;
    }
    return;
  }
  const gen = newestGeneration(live);
  if (gen === undefined) return;
  process.stderr.write(`adopt: live database missing; restoring ${gen}\n`);
  if (!(await restoreGeneration(live, gen))) {
    process.stderr.write(`adopt: newest generation failed boot: ${gen}\n`);
  }
}

function undoDisplace(live: string, gen: string): void {
  if (!isRegularFile(gen)) return;
  if (isRegularFile(live)) {
    const dest = uniqueAside(live, "partial");
    renameSync(live, dest);
    moveSidecars(live, dest);
  }
  unlinkSidecars(live);
  renameSync(gen, live);
  moveSidecars(gen, live);
}

function swapIn(live: string, pending: string): void {
  injected("enospc-swap");
  let gen: string | undefined;
  try {
    if (isRegularFile(live)) gen = displaceLive(live);
    injected("enospc-swap-after-displace");
    unlinkSidecars(live);
    try {
      checkpointLive(pending);
    } catch {
      // Sidecars move with the candidate so a WAL-only schema still boots.
    }
    renameSync(pending, live);
    moveSidecars(pending, live);
    pruneGenerations(live);
  } catch (err) {
    if (gen !== undefined) undoDisplace(live, gen);
    throw err;
  }
}

async function adoptPending(dbPath: string): Promise<AdoptResult> {
  const pending = pendingPath(dbPath);
  if (!isRegularFile(pending)) return { ok: true, adopted: false };
  const proved = await proveCandidate(pending);
  if (!proved.ok) {
    if (proved.kind === "env") {
      process.stderr.write(`adopt: prove deferred: ${proved.error}\n`);
      return { ok: false, error: proved.error };
    }
    process.stderr.write(`adopt: candidate failed boot check: ${proved.error}\n`);
    quarantinePending(pending);
    return { ok: true, adopted: false };
  }
  try {
    swapIn(dbPath, pending);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const liveOk = await proveCandidate(dbPath);
  if (liveOk.ok) return { ok: true, adopted: true, path: dbPath };
  if (liveOk.kind === "env") {
    process.stderr.write(`adopt: prove of swapped live deferred (${liveOk.error}); leaving swapped file in place\n`);
    return { ok: true, adopted: true, path: dbPath };
  }
  process.stderr.write(`adopt: swapped database failed boot; restoring newest generation: ${liveOk.error}\n`);
  quarantineLive(dbPath);
  const gen = newestGeneration(dbPath);
  if (gen !== undefined) await restoreGeneration(dbPath, gen);
  return { ok: true, adopted: false };
}

async function adoptClassified(dbPath: string): Promise<AdoptResult> {
  const pending = await adoptPending(dbPath);
  if (!pending.ok) return pending;
  await ensureLive(dbPath);
  if (pending.adopted && isRegularFile(dbPath)) return { ok: true, adopted: true, path: dbPath };
  return { ok: true, adopted: false };
}

export async function adopt(input: { dbPath: string }): Promise<AdoptResult> {
  try {
    return await adoptClassified(input.dbPath);
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
  if (command === "adopt") {
    const result = await adopt({ dbPath: env.DB_PATH || "prism.db" });
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
