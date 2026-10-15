// Must not import src/db.ts, src/server.ts, src/seed.ts, or src/access.ts.
// Those modules open the live database, write rows, or exit the process.

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

const STORAGE_FIELDS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RETENTION = /^(?:[1-9]|[12]\d|30)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

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

  return {
    ok: true,
    config: {
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: region === "" ? "auto" : region,
      retentionDays: Number(retentionRaw === "" ? "14" : retentionRaw) as RetentionDays,
    },
  };
}

export function snapshot(input: {
  env: typeof process.env;
  dbPath: string;
  now: Date;
}): Promise<SnapshotResult> {
  const read = readConfig(input.env);
  if (!read.ok) {
    if (read.kind === "missing") return Promise.resolve({ ok: true, skipped: true, reason: read.reason });
    return Promise.resolve({ ok: false, error: read.error });
  }
  void input.dbPath;
  void input.now;
  void read.config;
  return Promise.resolve({ ok: false, error: "snapshot is not implemented" });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return "";
  return value;
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

function writeResult(value: SnapshotResult): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(argv: readonly string[], env: typeof process.env): Promise<number> {
  if (argv[0] !== "snapshot") {
    writeResult({ ok: false, error: "unknown command" });
    return 1;
  }
  let now = new Date();
  const day = flag(argv, "--day");
  if (day !== undefined) {
    if (day === "" || parseDay(day) === undefined) {
      writeResult({ ok: false, error: "--day must be YYYY-MM-DD" });
      return 1;
    }
    now = new Date(`${day}T12:00:00.000Z`);
  }
  const result = await snapshot({ env, dbPath: env.DB_PATH || "prism.db", now });
  writeResult(result);
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2), process.env);
  } catch (err) {
    const error = err instanceof Error ? err.message : "snapshot process failed";
    writeResult({ ok: false, error });
  }
  process.exit(code);
}
