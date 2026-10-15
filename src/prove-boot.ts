// DB-only prove child: integrity/migrate, startup prepares, and counts.
// Does not import access, auth, server, or other modules that read app env/config.
const path = process.argv[2];
if (path === undefined || path === "") {
  process.stderr.write("prove-boot: missing database path\n");
  process.exit(1);
}

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

const { openDatabase } = await import("./open-db");
const { pooledTotals, experienceArms, banditTotalsIncludingUnkeyed } = await import("./counts");

const db = openDatabase(path);

db.prepare(
  "INSERT INTO sites (site, plan, created_at) VALUES (?, 'agency', ?) ON CONFLICT(site) DO UPDATE SET plan = excluded.plan",
);
db.prepare("SELECT COUNT(*) AS n FROM variants WHERE site = ?");
db.prepare(
  "INSERT INTO variants (site, name, selector, ops, audience, weight, active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)",
);
db.prepare("SELECT site FROM sites WHERE write_key = ?");
db.prepare("SELECT write_key FROM sites WHERE site = ?");
db.prepare("SELECT role FROM accounts WHERE email = ?");
db.prepare(
  `SELECT a.role AS account_role, s.site AS site, s.role AS site_role
   FROM accounts a LEFT JOIN account_sites s ON s.email = a.email
   WHERE a.email = ?`,
);
db.prepare("SELECT plan, holdout_pct FROM sites WHERE site = ?");
db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site = ? AND last_seen >= ?");
db.prepare(
  `SELECT site FROM sites
   UNION SELECT DISTINCT site FROM variants
   UNION SELECT DISTINCT site FROM events
   UNION SELECT DISTINCT site FROM visitors
   UNION SELECT DISTINCT site FROM orders`,
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
