import pLimit from 'p-limit';

import { extractBackupTimestamp, splitByRetention } from '@/lib/backup-timestamp';

import type { Logger } from 'pino';

import type { Retention } from '@/config';
import type { BackupProvider, ProviderFile } from '@/providers/types';

const DEFAULT_UPLOAD_CONCURRENCY = 3;

export interface SyncResult {
  uploaded: string[];
  skipped: string[];
  failed: { name: string; error: unknown }[];
}

export interface SyncContext {
  provider: BackupProvider;
  retention: Retention;
  logger: Logger;
}

const purgeBeyondRetention = async (
  { provider, retention, logger }: SyncContext,
  files: ProviderFile[],
): Promise<SyncResult['failed']> => {
  if (retention === false || files.length <= retention) {
    return [];
  }

  files.forEach((file) => {
    if (!extractBackupTimestamp(file.name)) {
      logger.warn(
        { fileName: file.name },
        'Could not extract a backup timestamp from file name, falling back to name comparison for retention',
      );
    }
  });

  const { beyond } = splitByRetention(files, retention, (file) => file.name);

  const results = await Promise.allSettled(
    beyond.map(async (file) => provider.deleteFile(file)),
  );

  const failedDeletes = results.flatMap((result, index) => (
    result.status === 'rejected' ? [{ name: beyond[index].name, error: result.reason }] : []
  ));

  if (failedDeletes.length > 0) {
    logger.error(
      {
        failedCount: failedDeletes.length,
        fileNames: failedDeletes.map(({ name }) => name),
        errors: failedDeletes.map(({ error }) => String(error)),
      },
      'Retention: some files could not be deleted',
    );
  }

  return failedDeletes;
};

export const syncDestination = async (
  context: SyncContext,
  path: string | undefined,
  files: File[],
): Promise<SyncResult> => {
  const { provider, retention, logger } = context;

  if (files.length === 0 && retention === false) {
    return { uploaded: [], skipped: [], failed: [] };
  }

  const destinationId = await provider.resolveDestination(path);
  let remoteFiles = destinationId === null ? [] : await provider.listFiles(destinationId);

  const uploaded: string[] = [];
  const skipped: string[] = [];
  const failed: { name: string; error: unknown }[] = [];

  const uploadLimit = pLimit(DEFAULT_UPLOAD_CONCURRENCY);

  const results = await Promise.allSettled(
    files.map(async (file) => uploadLimit(async () => {
      const remoteFile = remoteFiles.find(({ name }) => name === file.name);

      if (remoteFile) {
        const localHash = await provider.hashFile(file);

        if (remoteFile.hash === localHash) {
          logger.info(
            { fileName: file.name },
            'File already exists on kDrive, skipping upload',
          );

          skipped.push(file.name);
          return;
        }

        logger.warn(
          { fileName: file.name },
          'A different file with the same name already exists on kDrive',
        );
      }

      await provider.uploadFile(file, path);

      logger.info({ fileName: file.name }, 'Successfully uploaded');

      uploaded.push(file.name);
    })),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const file = files[index];

      logger.error(
        { fileName: file.name, error: result.reason },
        'Error uploading',
      );

      failed.push({ name: file.name, error: result.reason });
    }
  });

  if (retention === false) {
    return { uploaded, skipped, failed };
  }

  if (uploaded.length > 0) {
    const freshDestinationId = await provider.resolveDestination(path);
    remoteFiles = freshDestinationId === null ? [] : await provider.listFiles(freshDestinationId);
  }

  const failedDeletes = await purgeBeyondRetention(context, remoteFiles);

  return { uploaded, skipped, failed: [...failed, ...failedDeletes] };
};
