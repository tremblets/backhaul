import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Cron } from 'croner';

import { DATA_FOLDER } from '@/config';

import type { Config } from '@/config';
import type InfomaniakUploader from '@/infomaniak.uploader';

interface BackupSchedulerOptions {
  schedule: string;
}

class BackupScheduler {
  readonly #options: BackupSchedulerOptions;

  readonly #uploader: InfomaniakUploader;

  readonly #entries: Config['folders'];

  #job?: Cron;

  constructor(
    uploader: InfomaniakUploader,
    entries: Config['folders'],
    options: BackupSchedulerOptions,
  ) {
    this.#options = options;
    this.#entries = entries;
    this.#uploader = uploader;
  }

  async #getFiles(): Promise<File[]> {
    const files = await Promise.all(
      this.#entries.map(async (entry) => {
        const folder = join(DATA_FOLDER, entry.source);

        try {
          const directoryState = await stat(folder);

          if (!directoryState.isDirectory()) {
            console.warn(`Path is not a folder: ${folder}`);
            return [];
          }
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            console.warn(`Folder does not exist: ${folder}`);
            return [];
          }

          throw error;
        }

        const entries = await readdir(folder, { withFileTypes: true });

        return Promise.all(
          entries
            .filter((file) => file.isFile())
            .map(async (file) => {
              const filePath = join(folder, file.name);
              const buffer = await readFile(filePath);

              return new File([buffer], file.name);
            }),
        );
      }),
    );

    return files.flat();
  }

  init(): void {
    this.#job = new Cron(
      this.#options.schedule,
      {
        protect: () => console.warn('BackupScheduler: Job already running...'),
        catch: (error) => console.error('BackupScheduler: Error during job execution:', error),
      },
      async () => {
        console.log('BackupScheduler: Starting backup job...');

        const files = await this.#getFiles();

        const results = await Promise.allSettled(
          files.map(async (file) => {
            console.log(`BackupScheduler: Starting upload of "${file.name}"...`);

            try {
              await this.#uploader.uploadFile(file);

              console.log(`BackupScheduler: Successfully uploaded "${file.name}".`);
            } catch (error) {
              console.error(
                `BackupScheduler: Error uploading "${file.name}":`,
                error,
              );

              throw error;
            }
          }),
        );

        const success = results.filter((res) => res.status === 'fulfilled').length;
        const error = results.filter((res) => res.status === 'rejected').length;

        console.log('BackupScheduler: Backup job completed.');
        console.log(`BackupScheduler: ${success} uploaded, ${error} failed.`);
      },
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
