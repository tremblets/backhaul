import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Cron } from 'croner';
import pLimit from 'p-limit';

import { CRON_MODE, DATA_FOLDER } from '@/config';
import { splitByRetention } from '@/lib/backup-timestamp';
import { syncDestination } from '@/sync';

import type { Logger } from 'pino';

import type { ResolvedFolder, Retention } from '@/config';
import type { BackupProvider } from '@/providers/types';
import type { SyncResult } from '@/sync';

const DEFAULT_READ_CONCURRENCY = 10;
const MINUTE_MS = 60_000;

interface BackupSchedulerOptions {
  schedule: string;
  runOnStart?: boolean;
  minFileAge?: number;
}

export interface BackupRunResult extends SyncResult {
  deferred: string[];
  failedFolders: { folder: string; error: unknown }[];
  /** True when a stop was requested before the run could complete. */
  stopped: boolean;
}

export const isSuccessful = (result: BackupRunResult): boolean => (
  !result.stopped && result.failed.length === 0 && result.failedFolders.length === 0
);

interface LocalFileRef {
  name: string;
  folder: string;
  destination: string;
  retention: Retention;
}

interface LocalScan {
  refs: LocalFileRef[];
  deferred: string[];
  failedFolders: BackupRunResult['failedFolders'];
}

interface DestinationGroup {
  destination: string;
  retention: Retention;
  refs: LocalFileRef[];
}

const isMissingPathError = (error: unknown): boolean => (
  error instanceof Error && 'code' in error && error.code === 'ENOENT'
);

const groupByDestination = (refs: LocalFileRef[], logger: Logger): DestinationGroup[] => {
  const groups = new Map<string, DestinationGroup>();

  refs.forEach((ref) => {
    const group = groups.get(ref.destination) ?? {
      destination: ref.destination,
      retention: ref.retention,
      refs: [],
    };

    group.refs.push(ref);
    groups.set(ref.destination, group);
  });

  return [...groups.values()].map((group) => {
    if (group.retention === false) {
      return group;
    }

    const { kept, beyond } = splitByRetention(group.refs, group.retention, (ref) => ref.name);

    if (beyond.length > 0) {
      logger.debug(
        {
          destination: group.destination,
          prunedCount: beyond.length,
          files: beyond.map((ref) => ref.name),
        },
        'Skipping upload for files outside local retention window, they would be deleted immediately',
      );
    }

    return { ...group, refs: kept };
  });
};

const splitByAge = async (
  folder: string,
  names: string[],
  minFileAgeMs: number,
  logger: Logger,
): Promise<{ eligible: string[]; deferred: string[] }> => {
  if (minFileAgeMs === 0) {
    return { eligible: names, deferred: [] };
  }

  const now = Date.now();
  const ages = await Promise.all(names.map(async (name) => {
    const fileState = await stat(join(folder, name));

    // ctime also catches copies (rsync -a, cp -p) that restore an older mtime.
    return { name, ageMs: now - Math.max(fileState.mtimeMs, fileState.ctimeMs) };
  }));

  const deferred = ages.filter(({ ageMs }) => ageMs < minFileAgeMs);

  deferred.forEach(({ name, ageMs }) => {
    logger.info(
      { folder, fileName: name, ageSeconds: Math.round(ageMs / 1000) },
      'File modified too recently, deferring it to the next run',
    );
  });

  return {
    eligible: ages.filter(({ ageMs }) => ageMs >= minFileAgeMs).map(({ name }) => name),
    deferred: deferred.map(({ name }) => name),
  };
};

const readFiles = async (refs: LocalFileRef[]): Promise<File[]> => {
  const readLimit = pLimit(DEFAULT_READ_CONCURRENCY);

  return Promise.all(
    refs.map(async (ref) => readLimit(async () => {
      const blob = await openAsBlob(join(ref.folder, ref.name));

      return new File([blob], ref.name);
    })),
  );
};

class BackupScheduler {
  readonly #options: BackupSchedulerOptions;

  readonly #provider: BackupProvider;

  readonly #entries: ResolvedFolder[];

  readonly #logger: Logger;

  #job?: Cron;

  #currentRun?: { controller: AbortController; promise: Promise<BackupRunResult> };

  #stopRequested = false;

  constructor(
    provider: BackupProvider,
    logger: Logger,
    entries: ResolvedFolder[],
    options: BackupSchedulerOptions,
  ) {
    this.#options = options;
    this.#entries = entries;
    this.#provider = provider;
    this.#logger = logger.child({ module: 'scheduler' });
  }

  async #listLocalFileRefs(logger: Logger): Promise<LocalScan> {
    const scans = await Promise.all(
      this.#entries.map(async (entry): Promise<LocalScan> => {
        const folder = join(DATA_FOLDER, entry.source);

        try {
          const directoryState = await stat(folder);

          if (!directoryState.isDirectory()) {
            throw new Error(`Source path is not a folder: ${folder}`);
          }

          const dirents = await readdir(folder, { withFileTypes: true });

          const names = dirents
            .filter((dirent) => dirent.isFile())
            .map((dirent) => dirent.name)
            .filter((name) => {
              if (!name.startsWith('.')) {
                return true;
              }

              logger.debug({ folder, fileName: name }, 'Ignoring hidden file');
              return false;
            });

          if (names.length === 0) {
            logger.warn({ folder }, 'Source folder is empty');
          }

          const { eligible, deferred } = await splitByAge(
            folder,
            names,
            (this.#options.minFileAge ?? 0) * MINUTE_MS,
            logger,
          );

          const refs = eligible.map((name): LocalFileRef => ({
            name,
            folder,
            destination: entry.destination,
            retention: entry.retention,
          }));

          return { refs, deferred, failedFolders: [] };
        } catch (error) {
          logger.error(
            { folder, error },
            isMissingPathError(error) ? 'Source folder does not exist' : 'Could not read source folder',
          );

          return { refs: [], deferred: [], failedFolders: [{ folder, error }] };
        }
      }),
    );

    return {
      refs: scans.flatMap((scan) => scan.refs),
      deferred: scans.flatMap((scan) => scan.deferred),
      failedFolders: scans.flatMap((scan) => scan.failedFolders),
    };
  }

  async runBackup(): Promise<BackupRunResult> {
    const controller = new AbortController();

    if (this.#stopRequested) {
      controller.abort();
    }

    const currentRun = { controller, promise: this.#run(controller.signal) };
    this.#currentRun = currentRun;

    try {
      return await currentRun.promise;
    } finally {
      if (this.#currentRun === currentRun) {
        this.#currentRun = undefined;
      }
    }
  }

  async #run(signal: AbortSignal): Promise<BackupRunResult> {
    const logger = this.#logger.child({ runId: randomUUID() });

    logger.info('Starting backup job');

    const { refs, deferred, failedFolders } = await this.#listLocalFileRefs(logger);
    const groups = groupByDestination(refs, logger);

    const result: BackupRunResult = {
      uploaded: [],
      skipped: [],
      failed: [],
      interrupted: [],
      deferred,
      failedFolders,
      stopped: false,
    };

    await groups.reduce(async (previous, group) => {
      await previous;

      if (signal.aborted) {
        result.interrupted.push(...group.refs.map((ref) => ref.name));
        return;
      }

      try {
        const files = await readFiles(group.refs);

        const groupResult = await syncDestination(
          {
            provider: this.#provider, retention: group.retention, logger, signal,
          },
          group.destination,
          files,
        );

        result.uploaded.push(...groupResult.uploaded);
        result.skipped.push(...groupResult.skipped);
        result.failed.push(...groupResult.failed);
        result.interrupted.push(...groupResult.interrupted);
      } catch (error) {
        logger.error({ destination: group.destination, error }, 'Could not sync destination');
        result.failedFolders.push({ folder: group.destination, error });
      }
    }, Promise.resolve());

    result.stopped = signal.aborted;

    const summary = {
      uploaded: result.uploaded.length,
      skipped: result.skipped.length,
      deferred: result.deferred.length,
      interrupted: result.interrupted.length,
      failed: result.failed.length,
      failedFolders: result.failedFolders.length,
    };

    if (result.stopped) {
      logger.warn(summary, 'Backup job stopped before completion.');
      return result;
    }

    if (isSuccessful(result)) {
      logger.info(summary, 'Backup job completed.');
    } else {
      logger.error(summary, 'Backup job completed with errors.');
    }

    logger.info({ nextRunTime: this.nextRun() }, 'Next run');

    return result;
  }

  init(): void {
    this.#job = new Cron(
      this.#options.schedule,
      {
        mode: CRON_MODE,
        protect: () => this.#logger.warn('Job already running...'),
        catch: (error) => this.#logger.error({ error }, 'Error during job execution:'),
      },
      async () => {
        await this.runBackup();
      },
    );

    if (this.#options.runOnStart) {
      this.#logger.info('Running backup on start');
      // Goes through croner so `catch` handles errors and `protect` skips an overlapping tick.
      this.#job.trigger();
    }
  }

  nextRun(): string | null {
    return this.#job?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    this.#job?.stop();
  }

  /**
   * Stops the schedule, then waits for the current run: uploads in flight finish (without
   * retries), nothing new starts and retention is skipped.
   */
  async shutdown(): Promise<void> {
    this.#stopRequested = true;
    this.stop();

    const currentRun = this.#currentRun;

    if (!currentRun) {
      return;
    }

    currentRun.controller.abort();

    try {
      await currentRun.promise;
    } catch {
      // Already reported by whoever started the run.
    }
  }
}

export default BackupScheduler;
