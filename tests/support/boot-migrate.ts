const { db } = await import("../../src/db.ts");
await import("../../src/access.ts");

const visitor = db.prepare("SELECT id, site, visits, traits FROM visitors WHERE id = ?").get("keep-me");
const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pilot_inquiries'").get();
const inquiries = (db.prepare("SELECT COUNT(*) AS n FROM pilot_inquiries").get() as { n: number }).n;
const variants = (db.prepare("SELECT COUNT(*) AS n FROM variants").get() as { n: number }).n;
const events = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
const site = db.prepare("SELECT plan, write_key FROM sites WHERE site = ?").get("demo") as { plan: string; write_key: string | null } | null;
const orphan = db.prepare("SELECT write_key FROM sites WHERE site = ?").get("orphan-shop") as { write_key: string | null } | null;
const account = db.prepare("SELECT role FROM accounts WHERE email = ?").get("owner@prism.test");
const accountSites = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_sites'").get();
const accountSiteRows = (db.prepare("SELECT COUNT(*) AS n FROM account_sites").get() as { n: number }).n;

console.log(JSON.stringify({
  visitor, table, inquiries, variants, events,
  site: { plan: site?.plan },
  demoWriteKey: Boolean(site?.write_key && site.write_key.startsWith("wk_")),
  orphanWriteKey: Boolean(orphan?.write_key && orphan.write_key.startsWith("wk_")),
  account, accountSites, accountSiteRows,
}));
