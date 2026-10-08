// e2e app server: fresh seeded SQLite per run, then serve the Prism app.
// Usage: bun tests/support/serve.ts  (PORT, ADMIN_TOKEN, DEMO_TOKEN, HOLDOUT_PCT from env)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "prism-e2e-")), "prism.db");
await import("../../src/seed.ts");
await import("../../src/seed-stats.ts");
const { default: app } = await import("../../src/server.ts");
const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
console.log(`prism e2e server on http://127.0.0.1:${port} db=${process.env.DB_PATH}`);
