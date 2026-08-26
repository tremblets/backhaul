# backhaul

Scheduled backup tool that uploads local folders to [Infomaniak kDrive](https://www.infomaniak.com/en/kdrive), with configurable retention per destination. Runs as a long-lived scheduler or as a one-off CLI command, and ships as a container image.

## How it works

- On the configured cron schedule, the app reads the folders listed in your config, uploads each file to the matching kDrive destination folder, and skips files that already exist remotely with an identical hash.
- After uploading, it applies retention per destination: only the N most recent files are kept, older ones are deleted (retention can also be disabled per folder).
- Retention is determined by a timestamp extracted from the **file name**, not by kDrive's upload timestamp. This keeps retention correct even if a file is uploaded late (e.g. after a temporary outage or a catch-up sync) — the upload date can lag behind the backup's real age, but the file name doesn't (kDrive's API also caps how far in the past its own `created_at` can be overridden on upload, so that field can't be used to fix this up either).
  - Recognised formats: a `YYYY.MM.DD_HH.MM.SS` timestamp anywhere in the name (e.g. `sonarr_backup_v4.0.19.2979_2026.08.14_22.26.05.zip`), or a compact 14-digit `YYYYMMDDHHMMSS` run (e.g. `jellyfin-backup-20260806103437.zip`).
  - If no recognised timestamp is found, retention falls back to comparing the full file name and logs a warning — safe for names that already sort chronologically as plain strings (e.g. ISO-8601 prefixes), but incorrect for names where something other than the date (a version number, a random ID, ...) comes first.

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
schedule: '0 0 * * *' # cron expression, defaults to daily at midnight

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

### 2. Data volume

Mount the folders you want backed up into `/data`. Each `source` in `config.yml` is resolved relative to `/data`, e.g. `source: '/source/folder1'` reads files from `/data/source/folder1`.

### 3. Infomaniak API token

Provide your Infomaniak API token as `INFOMANIAK_API_KEY`, either as an environment variable or as a [Docker secret](https://docs.docker.com/engine/swarm/secrets/) mounted at `/run/secrets/infomaniak_api_key` (the secret file takes precedence if both are present).

## Running the container

### Docker run

```bash
docker run -d \
  --name backhaul \
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

## Running a backup manually

The image also exposes a `backup` CLI (`/usr/local/bin/backup`) for running a single backup outside of the schedule, e.g. against a running container:

```bash
docker exec backhaul backup start
```

## Volumes summary

| Path      | Purpose                                              |
| --------- | ----------------------------------------------------- |
| `/config` | Must contain `config.yml`.                            |
| `/data`   | Root folder that all `source` paths in the config are resolved against. |
