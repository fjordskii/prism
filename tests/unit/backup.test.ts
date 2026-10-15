import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");

const MISSING_S3 = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

test("snapshot with no S3 env exits 0 and prints the skip receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-backup-skip-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of [...MISSING_S3, "S3_REGION", "BACKUP_RETENTION_DAYS", "BACKUP_TOKEN"]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("AWS_")) delete env[key];
  }
  env.DB_PATH = join(dir, "absent.sqlite");

  const proc = Bun.spawn(["bun", "src/backup.ts", "snapshot"], {
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

  expect(code, stderr).toBe(0);
  expect(stdout).toBe(
    '{"ok":true,"skipped":true,"reason":"missing S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY"}\n',
  );
});
