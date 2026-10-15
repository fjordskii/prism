// Child used by adopt: open DB_PATH with boot init, prepare startup SQL, smoke-query tables.
const path = process.argv[2];
if (path === undefined || path === "") {
  process.stderr.write("prove-boot: missing database path\n");
  process.exit(1);
}
process.env.DB_PATH = path;

const hang = process.env.PRISM_PROVE_HANG === "1";
const delayMs = Number(process.env.PRISM_PROVE_DELAY_MS ?? "");
if (hang || (Number.isFinite(delayMs) && delayMs > 0)) {
  process.on("SIGTERM", () => {});
}
if (hang) {
  await Bun.sleep(3_600_000);
  process.exit(2);
}
if (Number.isFinite(delayMs) && delayMs > 0) await Bun.sleep(delayMs);

const { db } = await import("./db");
await import("./access");
await import("./auth");
await import("./write-key");
await import("./plans");
await import("./bandit");
await import("./experiences");
await import("./server");
const { pooledTotals, experienceArms, banditTotalsIncludingUnkeyed } = await import("./counts");

db.prepare(
  "INSERT INTO sites (site, plan, created_at) VALUES (?, 'agency', ?) ON CONFLICT(site) DO UPDATE SET plan = excluded.plan",
);
db.prepare("SELECT COUNT(*) AS n FROM variants WHERE site = ?");
db.prepare(
  "INSERT INTO variants (site, name, selector, ops, audience, weight, active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)",
);

pooledTotals(db, "_prove");
experienceArms(db, "_prove");
banditTotalsIncludingUnkeyed(db, 0, null);

const tables = db
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];
if (tables.length === 0) {
  process.stderr.write("prove-boot: no user tables\n");
  process.exit(1);
}
for (const table of tables) {
  db.prepare(`SELECT COUNT(*) AS n FROM "${table.name.replaceAll('"', '""')}"`).get();
}

db.close();
process.exit(0);
