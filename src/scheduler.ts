import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Cron } from 'croner';
import pLimit from 'p-limit';

import { DATA_FOLDER } from '@/config';

import type { Logger } from 'pino';

import type { ResolvedFolder, Retention } from '@/config';
import type InfomaniakProvider from '@/providers/infomaniak.provider';

const DEFAULT_UPLOAD_CONCURRENCY = 3;
const DEFAULT_READ_CONCURRENCY = 10;

interface BackupSchedulerOptions {
  schedule: string;
}

class BackupScheduler {
  readonly #options: BackupSchedulerOptions;

  readonly #provider: InfomaniakProvider;

  readonly #entries: ResolvedFolder[];

  readonly #logger: Logger;

  #job?: Cron;

  constructor(
    provider: InfomaniakProvider,
    logger: Logger,
    entries: ResolvedFolder[],
    options: BackupSchedulerOptions,
  ) {
    this.#options = options;
    this.#entries = entries;
    this.#provider = provider;
    this.#logger = logger.child({ module: 'scheduler' });
  }

  async #getFiles(
    logger: Logger,
  ): Promise<{ file: File; destination?: string; retention: Retention }[]> {
    const readLimit = pLimit(
      DEFAULT_READ_CONCURRENCY,
    );

    const files = await Promise.all(
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

        const entries = await readdir(folder, { withFileTypes: true });

        return Promise.all(
          entries
            .filter((file) => file.isFile())
            .map(async (file) => readLimit(async () => {
              const filePath = join(folder, file.name);
              const buffer = await readFile(filePath);

              return {
                file: new File([buffer], file.name),
                destination: entry.destination,
                retention: entry.retention,
              };
            })),
        );
      }),
    );

    return files.flat();
  }

  async #applyRetention(
    files: { destination?: string; retention: Retention }[],
    logger: Logger,
  ): Promise<void> {
    const retentionByDestination = new Map<string | undefined, Retention>();

    files.forEach((fileEntry) => {
      if (!retentionByDestination.has(fileEntry.destination)) {
        retentionByDestination.set(fileEntry.destination, fileEntry.retention);
      }
    });

    await Promise.allSettled(
      [...retentionByDestination.entries()].map(async ([destination, retention]) => {
        try {
          await this.#provider.applyRetention(destination, retention);
        } catch (error) {
          logger.error({ destination, error }, 'Error applying retention');
        }
      }),
    );
  }

  async runBackup(): Promise<void> {
    const logger = this.#logger.child({ runId: randomUUID() });

    logger.info('Starting backup job');

    const files = await this.#getFiles(logger);

    const uploadLimit = pLimit(
      DEFAULT_UPLOAD_CONCURRENCY,
    );

    const results = await Promise.allSettled(
      files.map(async (fileEntry) => uploadLimit(async () => {
        logger.info(
          {
            provider: this.#provider.name,
            fileName: fileEntry.file.name,
          },
          'Starting file upload',
        );

        try {
          const res = await this.#provider.uploadFile(
            fileEntry.file,
            fileEntry.destination,
          );

          if (res === 'uploaded') {
            logger.info(
              {
                provider: this.#provider.name,
                fileName: fileEntry.file.name,
              },
              'Successfully uploaded',
            );
          }
        } catch (error) {
          logger.error({
            provider: this.#provider.name,
            fileName: fileEntry.file.name,
            error,
          }, 'Error uploading');

          throw error;
        }
      })),
    );

    await this.#applyRetention(files, logger);

    const success = results.filter((res) => res.status === 'fulfilled').length;
    const error = results.filter((res) => res.status === 'rejected').length;

    logger.info({ success, error }, 'Backup job completed.');
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
