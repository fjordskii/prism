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

   The container command is `bun src/backup.ts adopt && bun run src/seed.ts && bun run src/server.ts`. `adopt` copies `/data/prism.restore` to a temp path **on the same volume** and opens that copy with the same schema/migrate step boot uses, then prepares the statements the app prepares at startup. Only a candidate that passes replaces live. Older-schema backups migrate up; a file with Prism table names and the wrong columns is rejected.

Any failure before the candidate is fully proven — copy, disk full, open, migrate, or prepare — leaves live exactly as it was. Environmental errors (ENOSPC, a full temp dir, a killed prove child) do not quarantine or rename live, leave `prism.restore` in place for the next boot, and exit 1 so seed does not create an empty database.

The displaced live file is checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) or moved with its `-wal`/`-shm` sidecars, then kept as `/data/prism.db.previous.<timestamp>`. Adopt keeps the newest three of those generations, ordered by the timestamp in the filename. A rejected candidate does not touch them, including when `prism.restore` is a symlink to `prism.db`. A `.previous` path that is a directory is skipped and does not stop the server.

If the first boot after an adopt cannot open the new live file, adopt restores the newest generation, logs that on stderr, and the server starts on the restored copy. A prove copy that runs out of disk does not count as "cannot open".

There is no HTTP restore. `BACKUP_TOKEN` cannot write a file onto the volume.
