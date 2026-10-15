import { Database } from "bun:sqlite";

const path = process.argv[2];
if (path === undefined || path === "") {
  process.stderr.write("missing database path\n");
  process.exit(1);
}

const db = new Database(path);
db.exec("PRAGMA journal_mode = WAL");
db.query("SELECT COUNT(*) AS n FROM visitors").get();
process.stdout.write("open\n");

await new Promise<void>((resolve) => {
  process.stdin.on("end", () => resolve());
  process.stdin.resume();
});

db.close();
