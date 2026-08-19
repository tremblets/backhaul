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

  readonly #uploader: InfomaniakProvider;

  readonly #entries: ResolvedFolder[];

  readonly #logger: Logger;

  #job?: Cron;

  constructor(
    uploader: InfomaniakProvider,
    logger: Logger,
    entries: ResolvedFolder[],
    options: BackupSchedulerOptions,
  ) {
    this.#options = options;
    this.#entries = entries;
    this.#uploader = uploader;
    this.#logger = logger;
  }

  async #getFiles(): Promise<{ file: File; destination?: string; retention: Retention }[]> {
    const readLimit = pLimit(
      DEFAULT_READ_CONCURRENCY,
    );

    const files = await Promise.all(
      this.#entries.map(async (entry) => {
        const folder = join(DATA_FOLDER, entry.source);

        try {
          const directoryState = await stat(folder);

          if (!directoryState.isDirectory()) {
            this.#logger.warn({ folder }, 'Path is not a folder');
            return [];
          }
        } catch (error) {
          if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
          ) {
            this.#logger.warn({ folder }, 'Folder does not exist');
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

  async runBackup(): Promise<void> {
    this.#logger.info('BackupScheduler: Starting backup job...');

    const files = await this.#getFiles();

    const uploadLimit = pLimit(
      DEFAULT_UPLOAD_CONCURRENCY,
    );

    const results = await Promise.allSettled(
      files.map(async (fileEntry) => uploadLimit(async () => {
        this.#logger.info({ fileName: fileEntry.file.name }, 'BackupScheduler: Starting upload');

        try {
          await this.#uploader.uploadFile(
            fileEntry.file,
            fileEntry.destination,
            {
              retention: fileEntry.retention,
            },
          );

          this.#logger.info({ fileName: fileEntry.file.name }, 'BackupScheduler: Successfully uploaded');
        } catch (error) {
          this.#logger.error({ fileName: fileEntry.file.name, error }, 'BackupScheduler: Error uploading');

          throw error;
        }
      })),
    );

    const success = results.filter((res) => res.status === 'fulfilled').length;
    const error = results.filter((res) => res.status === 'rejected').length;

    this.#logger.info({ success, error }, 'BackupScheduler: Backup job completed.');
  }

  init(): void {
    this.#job = new Cron(
      this.#options.schedule,
      {
        protect: () => this.#logger.warn('BackupScheduler: Job already running...'),
        catch: (error) => this.#logger.error({ error }, 'BackupScheduler: Error during job execution:'),
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
