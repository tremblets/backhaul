import XXHash from 'xxhash-addon';

import { HttpError, isTransientError, withRetry } from '@/lib/retry';

import type { Logger } from 'pino';

import type { Retention } from '@/config';

const API_URL = 'https://api.infomaniak.com';
const METADATA_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 300_000;

interface InfomaniakProviderOptions {
  folderUrl: string;
  token: string;
}

interface ErrorResponse {
  result: 'error';
  error: {
    code: string;
    description: string;
  };
}

interface RemoteFile {
  id: number;
  name: string;
  type: 'dir' | 'file';
  size?: number;
  created_at: number;
  hash?: string;
}

interface GetFileSuccessResponse {
  result: 'success';
  data: RemoteFile;
}

interface ListFilesSuccessResponse {
  result: 'success';
  data: RemoteFile[];
  cursor: string;
  has_more: boolean;
  response_at: number;
}

type GetFileResponse = GetFileSuccessResponse | ErrorResponse;
type ListFilesResponse = ListFilesSuccessResponse | ErrorResponse;

interface UploadSuccessResponse {
  result: 'success';
  data: {
    id: number;
    name: string;
    type: 'dir' | 'file';
    status: string;
    visibility: string;
    drive_id: number;
    depth: number;
    created_by: number;
    created_at: number;
    added_at: number;
    last_modified_at: number;
    last_modified_by: number;
    revised_at: number;
    updated_at: number;
    parent_id: number;
    size: number;
    mime_type: string;
    extension_type: string;
    scan_status: string;
  };
}

type UploadResponse = UploadSuccessResponse | ErrorResponse;

interface DeleteFileSuccessResponse {
  result: 'success';
  data: {
    cancel_id: string;
    valid_until: number;
  };
}

type DeleteFileResponse = DeleteFileSuccessResponse | ErrorResponse;

interface DeleteFileFromTrashSuccessResponse {
  result: 'success';
  data: true;
}

type DeleteFileFromTrashResponse = DeleteFileFromTrashSuccessResponse | ErrorResponse;

const extractIds = (url: string): { driveId: number; folderId: number } => {
  const regex = /.+\.infomaniak\.com\/[0-9]+\/kdrive\/app\/drive\/([0-9]+)\/files\/([0-9]+)/;
  const match = regex.exec(url);
  if (!match) {
    throw new Error('Invalid folder URL');
  }

  return { driveId: Number(match[1]), folderId: Number(match[2]) };
};

const hashFile = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  const hash = XXHash.XXHash3.hash(Buffer.from(buffer)).toString('hex');

  return `xxh3:${hash}`;
};

class InfomaniakProvider {
  readonly name: string = 'KDrive';

  readonly #logger: Logger;

  readonly #token: string;

  readonly #driveId: number;

  readonly #folderId: number;

  readonly #baseV2: string = `${API_URL}/2/drive`;

  readonly #baseV3: string = `${API_URL}/3/drive`;

  constructor(logger: Logger, options: InfomaniakProviderOptions) {
    const { driveId, folderId } = extractIds(options.folderUrl);

    this.#logger = logger.child({ module: this.name });
    this.#token = options.token;
    this.#driveId = driveId;
    this.#folderId = folderId;
  }

  async #resolveFolderId(path?: string): Promise<number | null> {
    const parts = path?.split('/').filter(Boolean) ?? [];

    this.#logger.debug({ path }, 'Getting folders IDs for path');

    const resolve = async (
      index: number,
      currentFolderId: number,
    ): Promise<number | null> => {
      const part = parts[index];

      if (!part) {
        return currentFolderId;
      }

      const queryParams = new URLSearchParams({ name: part });

      this.#logger.debug({ folderName: part }, 'Getting folder ID');

      let result: GetFileSuccessResponse;

      try {
        result = await withRetry(
          async () => {
            const response = await fetch(
              `${this.#baseV3}/${this.#driveId}/files/${currentFolderId}/name?${queryParams}`,
              {
                headers: {
                  Authorization: `Bearer ${this.#token}`,
                },
                signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
              },
            );

            if (response.status === 404) {
              throw new HttpError(404, `"${part}" not found in kDrive folder ${currentFolderId}`);
            }

            if (!response.ok) {
              throw new HttpError(
                response.status,
                `Failed to find "${part}" in kDrive folder ${currentFolderId} (HTTP ${response.status})`,
              );
            }

            const data: GetFileResponse = await response.json();

            if (data.result === 'error') {
              throw new HttpError(
                data.error.code === 'file_not_found' ? 404 : 400,
                `Failed to find "${part}": ${JSON.stringify(data.error)}`,
              );
            }

            if (data.data.type !== 'dir') {
              throw new HttpError(400, `"${part}" is not a directory`);
            }

            return data;
          },
          { isRetryable: isTransientError },
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          this.#logger.debug(
            { folderName: part },
            'Folder does not exist yet, will be created on upload',
          );

          return null;
        }

        throw error;
      }

      this.#logger.debug(
        { folderName: part, folderId: result.data.id },
        'Folder ID',
      );

      return resolve(index + 1, result.data.id);
    };

    return resolve(0, this.#folderId);
  }

  async #listFiles(folderId: number): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let cursor: string | undefined;

    this.#logger.debug({ folderId }, 'Listing files in folder');

    do {
      const queryParams = new URLSearchParams({
        with: 'hash',
      });

      if (cursor) {
        queryParams.set('cursor', cursor);
      }

      // eslint-disable-next-line no-await-in-loop
      const data = await withRetry(
        async () => {
          const response = await fetch(
            `${this.#baseV3}/${this.#driveId}/files/${folderId}/files?${queryParams}`,
            {
              headers: {
                Authorization: `Bearer ${this.#token}`,
              },
              signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
            },
          );

          if (!response.ok) {
            throw new HttpError(
              response.status,
              `Failed to list kDrive folder ${folderId} (HTTP ${response.status})`,
            );
          }

          const parsedData: ListFilesResponse = await response.json();

          if (parsedData.result === 'error') {
            throw new HttpError(400, `Failed to list files: ${JSON.stringify(parsedData.error)}`);
          }

          return parsedData;
        },
        { isRetryable: isTransientError },
      );

      this.#logger.debug({ folderId, files: data.data }, 'Files and folders in folder');

      files.push(...data.data.filter((file) => file.type === 'file'));
      cursor = data.has_more ? data.cursor : undefined;
    } while (cursor);

    this.#logger.debug({ folderId, files }, 'Files in folder');

    return files;
  }

  async #purgeFile(fileId: number): Promise<void> {
    await this.#deleteFile(fileId);
    await this.deleteFileFromTrash(fileId);
  }

  async applyRetention(path: string | undefined, retention: Retention): Promise<void> {
    if (retention === false) {
      return;
    }

    const folderId = await this.#resolveFolderId(path);
    const files = folderId === null ? [] : await this.#listFiles(folderId);

    if (files.length <= retention) {
      return;
    }

    const filesToDelete = [...files]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(retention);

    const results = await Promise.allSettled(
      filesToDelete.map(async (file) => this.#purgeFile(file.id)),
    );

    const failed = results.filter(
      (result) => result.status === 'rejected',
    );

    if (failed.length > 0) {
      this.#logger.error(
        {
          failedCount: failed.length,
          errors: failed.map((result) => String(result.reason)),
        },
        'Retention: some files could not be deleted',
      );
    }
  }

  async uploadFile(
    file: File,
    path?: string,
  ): Promise<'uploaded' | 'skipped'> {
    const folderId = await this.#resolveFolderId(path);
    const remoteFiles = folderId === null ? [] : await this.#listFiles(folderId);
    const remoteFile = remoteFiles.find(({ name }) => name === file.name);

    if (remoteFile) {
      const localHash = await hashFile(file);

      this.#logger.debug({ localHash }, 'File hash');

      if (remoteFile.hash === localHash) {
        this.#logger.info(
          { fileName: file.name },
          'File already exists on kDrive, skipping upload',
        );

        return 'skipped';
      }

      this.#logger.warn(
        { fileName: file.name },
        'A different file with the same name already exists on kDrive',
      );
    }

    const queryParams = new URLSearchParams({
      file_name: file.name,
      total_size: file.size.toString(),
      directory_id: this.#folderId.toString(),
      ...(path ? { directory_path: path } : {}),
    });

    await withRetry(
      async () => {
        const response = await fetch(
          `${this.#baseV3}/${this.#driveId}/upload?${queryParams}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#token}`,
            },
            body: file,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          throw new HttpError(response.status, `Failed to initiate upload (HTTP ${response.status})`);
        }

        const parsedData: UploadResponse = await response.json();

        if (parsedData.result === 'error') {
          throw new HttpError(400, `Upload error: ${JSON.stringify(parsedData.error)}`);
        }

        return parsedData;
      },
      { isRetryable: isTransientError },
    );

    return 'uploaded';
  }

  async #deleteFile(fileId: number): Promise<void> {
    await withRetry(
      async () => {
        const response = await fetch(
          `${this.#baseV2}/${this.#driveId}/files/${fileId.toString()}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${this.#token}`,
            },
            signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          throw new HttpError(response.status, 'Failed to initiate delete');
        }

        const data: DeleteFileResponse = await response.json();

        if (data.result === 'error') {
          throw new HttpError(400, `Delete error: ${JSON.stringify(data.error)}`);
        }
      },
      { isRetryable: isTransientError },
    );

    this.#logger.info(
      { fileId },
      'File deleted successfully',
    );
  }

  async deleteFileFromTrash(fileId: number): Promise<void> {
    await withRetry(
      async () => {
        const response = await fetch(
          `${this.#baseV2}/${this.#driveId}/trash/${fileId.toString()}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${this.#token}`,
            },
            signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          throw new HttpError(response.status, 'Failed to initiate delete from trash');
        }

        const data: DeleteFileFromTrashResponse = await response.json();

        if (data.result === 'error') {
          throw new HttpError(400, `Delete from trash error: ${JSON.stringify(data.error)}`);
        }
      },
      { isRetryable: isTransientError },
    );

    this.#logger.info(
      { fileId },
      'File deleted from trash successfully',
    );
  }
}

export default InfomaniakProvider;
