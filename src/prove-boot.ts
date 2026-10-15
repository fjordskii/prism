// Child used by restore: open DB_PATH with the same modules boot loads, including env/config.
const path = process.argv[2];
if (path === undefined || path === "") {
  process.stderr.write("prove-boot: missing database path\n");
  process.exit(1);
}
process.env.DB_PATH = path;

const { db } = await import("./db");
await import("./access");
await import("./auth");
await import("./write-key");
await import("./plans");
await import("./bandit");
await import("./experiences");
await import("./server");

db.close();
process.exit(0);
