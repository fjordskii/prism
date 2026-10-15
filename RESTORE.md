# Restore a Prism database

The restore CLI never writes `/data/prism.db`. It downloads a daily snapshot, runs `PRAGMA integrity_check`, boots the app's real startup (the same modules boot loads, with the real config) against a copy, and writes a **new** file. You swap that file onto the live path yourself.

You need `flyctl` logged in to `prism-personalize`. The S3 secrets must already be set on that app. `fly ssh` does not start a stopped machine.

Replace `2026-10-14` with the UTC day you want. Omit `--date` to take the newest object.

There is no HTTP restore. `BACKUP_TOKEN` cannot write a file onto the volume. Boot does not read a restore file.

## 1. Start the machine

```sh
fly machine start -a prism-personalize
```

## 2. Restore to a new file

Never `--to /data/prism.db`.

```sh
fly ssh console -a prism-personalize -C \
  "bun src/backup.ts restore --date 2026-10-14 --to /data/prism-restored.sqlite"
```

The command prints one JSON object. Success includes `"integrity":"ok"`, `"boot":"ok"`, and a `counts` object with one number for each user table. Live `/data/prism.db` is not opened for write.

`restore` refuses `--to` when that path is the live database or a side file (`-wal`, `-shm`, `-journal`, `.previous` and timestamped generations), including after symlink and hardlink resolution and a case-insensitive match. A dangling symlink whose target is one of those side files is also refused. It also refuses a file named `prism.db`.

## 3. Stop the machine

Nothing must hold `/data/prism.db` open during the swap.

```sh
fly machine stop -a prism-personalize
```

## 4. Hold the machine without opening the database

A stopped machine cannot be sshed into. Start it with `sleep` so the volume is mounted and the app is not running.

```sh
MACHINE=$(fly machine list -a prism-personalize -q | head -n 1)
fly machine update "$MACHINE" -a prism-personalize --command "sleep inf" --skip-health-checks -y
```

## 5. Keep the old live file and move the verified copy in

```sh
fly ssh console -a prism-personalize -C \
  "cp /data/prism.db /data/prism.db.\$(date -u +%F) && mv /data/prism-restored.sqlite /data/prism.db && rm -f /data/prism.db-wal /data/prism.db-shm"
```

## 6. Start the app with the same command master uses

```sh
MACHINE=$(fly machine list -a prism-personalize -q | head -n 1)
fly machine update "$MACHINE" -a prism-personalize \
  --command "sh -c 'bun run src/seed.ts && bun run src/server.ts'" -y
```

That command is the Dockerfile `CMD`. The next `fly deploy` replaces the machine from the image.

## 7. Check

```sh
curl -fsS https://prism-personalize.fly.dev/snippet.js >/dev/null
fly ssh console -a prism-personalize -C \
  "bun -e 'import { Database } from \"bun:sqlite\"; const db = new Database(\"/data/prism.db\", { readonly: true }); console.log(db.query(\"PRAGMA integrity_check\").get()); console.log(db.query(\"SELECT COUNT(*) AS n FROM visitors\").get()); db.close();'"
```

Integrity should print `ok`. Visitor count should match the `counts` object from step 2.
