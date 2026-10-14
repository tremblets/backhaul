# backhaul

Scheduled backup tool that uploads local folders to [Infomaniak kDrive](https://www.infomaniak.com/en/kdrive), with configurable retention per destination. Runs as a long-lived scheduler or as a one-off CLI command, and ships as a container image.

## How it works

- On the configured cron schedule, the app reads the folders listed in your config, uploads each file to the matching kDrive destination folder, and skips files that already exist remotely with an identical hash.
- Only regular files directly inside each source folder are backed up. Hidden files (names starting with `.`, e.g. `.DS_Store` or `rsync` temporary files) are ignored.
- Files changed less than `minFileAge` minutes ago (5 by default) are left for the next run, so a backup still being written or copied is never uploaded half-done. The age is taken from the most recent of the file's modification and change times, which also covers copies that preserve the original modification time (`rsync -a`, `cp -p`).
- After uploading, it applies retention per destination: only the N most recent files are kept, older ones are deleted (retention can also be disabled per folder).
- Retention is determined by a timestamp extracted from the **file name**, not by kDrive's upload timestamp. This keeps retention correct even if a file is uploaded late (e.g. after a temporary outage or a catch-up sync) — the upload date can lag behind the backup's real age, but the file name doesn't (kDrive's API also caps how far in the past its own `created_at` can be overridden on upload, so that field can't be used to fix this up either).
  - Recognised formats: a `YYYY.MM.DD_HH.MM.SS` timestamp anywhere in the name (e.g. `sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip`), or a compact 14-digit `YYYYMMDDHHMMSS` run (e.g. `jellyfin-backup-20260806103437.zip`).
  - If no recognised timestamp is found, retention falls back to comparing the full file name and logs a warning — safe for names that already sort chronologically as plain strings (e.g. ISO-8601 prefixes), but incorrect for names where something other than the date (a version number, a random ID, ...) comes first.
- Files are streamed from disk for both hashing and upload, so memory use stays flat whatever the file size. kDrive's direct upload is limited to 1 GB per file: larger files are refused with an explicit error and counted as failures (support for them is tracked in [#18](https://github.com/tremblets/backhaul/issues/18)).
- Each folder is processed independently. If a source folder is missing (e.g. a volume that isn't mounted) or can't be read, or a destination can't be synced, the error is logged and the other folders are still backed up. An empty source folder only logs a warning.
- At the end of each run, a summary is logged: `Backup job completed.` at `info` level when everything succeeded, `Backup job completed with errors.` at `error` level when a file upload, a retention deletion or a folder failed, and `Backup job stopped before completion.` at `warn` level when the app was stopped mid-run (see [Stopping](#stopping)).

## Image

Published to GitHub Container Registry:

```bash
docker pull ghcr.io/tremblets/backhaul:latest
```

Tags follow semver (`1`, `1.2`, `1.2.3`, `latest`).

## Configuration

The app needs three things: a config file, your data folders, and an API token.

### 1. `config.yml`

Mount a `config.yml` file into `/config` inside the container. Example:

```yaml
schedule: '0 0 * * *' # standard 5-field cron expression, defaults to daily at midnight
runOnStart: false # also run a backup as soon as the container starts, defaults to false
minFileAge: 5 # minutes since a file's last change before it is backed up (0 to disable), defaults to 5

infomaniak:
  folderUrl: 'https://ksuite.infomaniak.com/02468/kdrive/app/drive/12345/files/67890' # URL of the destination kDrive folder

defaults:
  retention: 3 # default number of files to keep per destination (false to disable)

folders:
  - source: '/source/folder1' # path relative to the /data volume
    destination: '/destination/folder1' # path relative to the kDrive folder above
  - source: '/source/folder2'
    destination: '/destination/folder2'
    retention: 10 # overrides the default for this folder
```

`infomaniak.folderUrl` is the URL of the kDrive folder you see in your browser when browsing to the destination folder — it's used to resolve the drive and root folder IDs.

`schedule` must be a standard 5-field cron expression (`minute hour day-of-month month day-of-week`): a leading seconds field and `@daily`-style aliases are rejected.

The config is validated strictly at startup. The app refuses to start, with an error naming the offending field, when:

- a key is unknown, e.g. a typo such as `retension: 10` (`folders.0: Unrecognized key: "retension"`);
- two folders share the same `destination` (`/backups/app` and `backups/app/` count as the same);
- `schedule` is not a valid standard cron expression.

### 2. Data volume

Mount the folders you want backed up into `/data`. Each `source` in `config.yml` is resolved relative to `/data`, e.g. `source: '/source/folder1'` reads files from `/data/source/folder1`.

### 3. Infomaniak API token

Provide your Infomaniak API token as `INFOMANIAK_API_KEY`, either as an environment variable or as a [Docker secret](https://docs.docker.com/engine/swarm/secrets/) mounted at `/run/secrets/infomaniak_api_key` (the secret file takes precedence if both are present).

## Running the container

### Docker run

```bash
docker run -d \
  --name backhaul \
  --stop-timeout 300 \
  -e INFOMANIAK_API_KEY=<your_token> \
  -e TZ=Europe/Zurich \
  -v $(pwd)/config.yml:/config/config.yml:ro \
  -v $(pwd)/data:/data:ro \
  ghcr.io/tremblets/backhaul:latest
```

### Docker Compose

```yaml
services:
  backhaul:
    image: ghcr.io/tremblets/backhaul:latest
    restart: unless-stopped
    stop_grace_period: 5m # let in-flight uploads finish on `docker compose down`
    environment:
      TZ: Europe/Zurich
    secrets:
      - infomaniak_api_key
    volumes:
      - ./config.yml:/config/config.yml:ro
      - ./data:/data:ro

secrets:
  infomaniak_api_key:
    file: ./infomaniak_api_key.txt
```

### Environment variables

| Variable              | Required | Default      | Description                                            |
| ---------------------- | -------- | ------------ | -------------------------------------------------------- |
| `INFOMANIAK_API_KEY`   | yes*     | -            | Infomaniak API token. *Not required if using a Docker secret instead. |
| `TZ`                    | no       | -            | Timezone used to evaluate the cron schedule.            |
| `LOG_LEVEL`             | no       | `info`       | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `NODE_ENV`              | no       | `production` | `development`, `test`, or `production`.                 |

## Stopping

On `SIGTERM` (`docker stop`, `docker compose down`) or `SIGINT`, the app stops gracefully:

- uploads already in progress are allowed to finish (a failing one is no longer retried);
- no new upload starts: the remaining files and folders are picked up by the next run;
- retention is not applied to an interrupted run, so nothing gets deleted on the way out.

Docker kills the container 10 seconds after `docker stop` by default, which is usually too short for an upload to finish. Give it more time with `stop_grace_period` (Compose) or `--stop-timeout` (`docker run`), as in the examples above: 5 minutes is enough for files up to 1 GB on most connections. A second signal exits immediately.

## Running a backup manually

The image also exposes a `backup` CLI (`/usr/local/bin/backup`) for running a single backup outside of the schedule, e.g. against a running container:

```bash
docker exec backhaul backup start
```

The command exits with code `0` when everything succeeded, and `1` when a file upload, a retention deletion or a folder failed (details in the logs), or when the run was stopped. `Ctrl+C` stops it gracefully like `SIGTERM` above, a second `Ctrl+C` exits immediately.

## Volumes summary

| Path      | Purpose                                              |
| --------- | ----------------------------------------------------- |
| `/config` | Must contain `config.yml`.                            |
| `/data`   | Root folder that all `source` paths in the config are resolved against. |
