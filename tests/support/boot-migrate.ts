const { db } = await import("../../src/db.ts");

const visitor = db.prepare("SELECT id, site, visits, traits FROM visitors WHERE id = ?").get("keep-me");
const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pilot_inquiries'").get();
const inquiries = (db.prepare("SELECT COUNT(*) AS n FROM pilot_inquiries").get() as { n: number }).n;
const variants = (db.prepare("SELECT COUNT(*) AS n FROM variants").get() as { n: number }).n;
const events = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
const site = db.prepare("SELECT plan FROM sites WHERE site = ?").get("demo");
const account = db.prepare("SELECT role FROM accounts WHERE email = ?").get("owner@prism.test");

console.log(JSON.stringify({ visitor, table, inquiries, variants, events, site, account }));
