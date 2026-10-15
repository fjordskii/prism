# Restore a Prism database

Use this to put a daily snapshot in place of the live database at `/data/prism.db`. `restore` writes `/data/prism.restore` and does not open the live file. The next boot runs `adopt` before `seed` opens the database.

You need `flyctl` logged in to the `prism-personalize` app. The S3 secrets must already be set on that app.

1. Start the machine if it is stopped.

   ```sh
   fly machine start -a prism-personalize
   ```

2. Write one snapshot to `/data/prism.restore`. Replace the date with the UTC day you want. Omit `--date` to take the newest object.

   ```sh
   fly ssh console -a prism-personalize -C \
     "bun src/backup.ts restore --date 2026-10-14 --to /data/prism.restore"
   ```

   The command prints one JSON object. Success includes `"integrity":"ok"` and a `counts` object with one number for each user table. If the command is killed before it finishes, `/data/prism.restore` is unchanged. Run the same command again.

   `restore` refuses `--to` when that path is the live database or a side file (`-wal`, `-shm`, `-journal`, `.previous`), including after symlink and hardlink resolution and a case-insensitive match. It also refuses a file named `prism.db`.

3. Restart the machine.

   ```sh
   fly machine restart -a prism-personalize
   ```

   The container command is `bun src/backup.ts adopt && bun run src/seed.ts && bun run src/server.ts`. `adopt` checks `/data/prism.restore`, moves the live file aside, and puts the restored file at `/data/prism.db`. The displaced live file stays at `/data/prism.db.previous` until a later adopt replaces it.

If `/data/prism.restore` is empty, corrupt, not a database, or missing a table from `src/db.ts`, `adopt` moves it to `/data/prism.restore.rejected`, writes that path to stderr, and the server starts on the live file. `.previous` is left in place.

There is no HTTP restore. `BACKUP_TOKEN` cannot write a file onto the volume.
