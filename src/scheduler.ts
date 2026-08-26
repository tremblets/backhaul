import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Cron } from 'croner';
import pLimit from 'p-limit';

import { DATA_FOLDER } from '@/config';
import { splitByRetention } from '@/lib/backup-timestamp';
import { syncDestination } from '@/sync';

import type { Logger } from 'pino';

import type { ResolvedFolder, Retention } from '@/config';
import type { BackupProvider } from '@/providers/types';

const DEFAULT_READ_CONCURRENCY = 10;

interface BackupSchedulerOptions {
  schedule: string;
}

interface LocalFileRef {
  name: string;
  folder: string;
  destination?: string;
  retention: Retention;
}

interface DestinationGroup {
  destination?: string;
  retention: Retention;
  refs: LocalFileRef[];
}

const groupByDestination = (refs: LocalFileRef[], logger: Logger): DestinationGroup[] => {
  const groups = new Map<string | undefined, DestinationGroup>();

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
      logger.info(
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

const readFiles = async (refs: LocalFileRef[]): Promise<File[]> => {
  const readLimit = pLimit(DEFAULT_READ_CONCURRENCY);

  return Promise.all(
    refs.map(async (ref) => readLimit(async () => {
      const filePath = join(ref.folder, ref.name);
      const buffer = await readFile(filePath);

      return new File([buffer], ref.name);
    })),
  );
};

class BackupScheduler {
  readonly #options: BackupSchedulerOptions;

  readonly #provider: BackupProvider;

  readonly #entries: ResolvedFolder[];

  readonly #logger: Logger;

  #job?: Cron;

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

  async #listLocalFileRefs(logger: Logger): Promise<LocalFileRef[]> {
    const refs = await Promise.all(
      this.#entries.map(async (entry) => {
        const folder = join(DATA_FOLDER, entry.source);

        try {
          const directoryState = await stat(folder);

          if (!directoryState.isDirectory()) {
            logger.warn({ folder }, 'Path is not a folder');
            return [];
          }
        } catch (error) {
          if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
          ) {
            logger.warn({ folder }, 'Folder does not exist');
            return [];
          }

          throw error;
        }

        const dirents = await readdir(folder, { withFileTypes: true });

        return dirents
          .filter((dirent) => dirent.isFile())
          .map((dirent): LocalFileRef => ({
            name: dirent.name,
            folder,
            destination: entry.destination,
            retention: entry.retention,
          }));
      }),
    );

    return refs.flat();
  }

  async runBackup(): Promise<void> {
    const logger = this.#logger.child({ runId: randomUUID() });

    logger.info('Starting backup job');

    const localRefs = await this.#listLocalFileRefs(logger);
    const groups = groupByDestination(localRefs, logger);

    const uploaded: string[] = [];
    const skipped: string[] = [];
    const failed: { name: string; error: unknown }[] = [];

    await groups.reduce(async (previous, group) => {
      await previous;

      const files = await readFiles(group.refs);

      const result = await syncDestination(
        this.#provider,
        group.destination,
        files,
        group.retention,
        logger,
      );

      uploaded.push(...result.uploaded);
      skipped.push(...result.skipped);
      failed.push(...result.failed);
    }, Promise.resolve());

    logger.info(
      {
        uploaded: uploaded.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      'Backup job completed.',
    );
  }

  init(): void {
    this.#job = new Cron(
      this.#options.schedule,
      {
        protect: () => this.#logger.warn('Job already running...'),
        catch: (error) => this.#logger.error({ error }, 'Error during job execution:'),
      },
      async () => this.runBackup(),
    );
  }

  nextRun(): string | null {
    return this.#job?.nextRun()?.toISOString() ?? null;
  }

  stop(): void {
    this.#job?.stop();
  }
}

export default BackupScheduler;
