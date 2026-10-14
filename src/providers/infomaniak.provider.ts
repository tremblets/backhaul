import { once } from 'node:events';
import { request } from 'node:https';
import { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

import XXHash from 'xxhash-addon';

import { HttpError, isTransientError, withRetry } from '@/lib/retry';

import type { IncomingMessage } from 'node:http';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { Logger } from 'pino';

import type { BackupProvider, ProviderFile } from './types';

const API_URL = 'https://api.infomaniak.com';
const METADATA_TIMEOUT_MS = 10_000;
const UPLOAD_IDLE_TIMEOUT_MS = 120_000;
// kDrive's direct upload does not accept files larger than 1 GB, they need an upload session.
const MAX_DIRECT_UPLOAD_SIZE = 2 ** 30;

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

// File.stream() is typed as the DOM ReadableStream, which Readable.fromWeb does not accept.
const streamFile = (file: File): Readable => Readable.fromWeb(
  file.stream() as NodeReadableStream<Uint8Array>,
);

const computeFileHash = async (file: File): Promise<string> => {
  // The binding has no runtime type checks: a hasher created without a seed buffer segfaults.
  const hasher = new XXHash.XXHash3(Buffer.alloc(8));

  await pipeline(
    streamFile(file),
    new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        hasher.update(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        callback();
      },
    }),
  );

  return `xxh3:${hasher.digest().toString('hex')}`;
};

// Streams the file through node:https: fetch buffers the whole request body in memory.
const postFile = async (
  url: string,
  token: string,
  file: File,
): Promise<{ status: number; body: string }> => {
  const req = request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Length': file.size,
    },
  });

  req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
    req.destroy(new Error(`Upload timed out after ${UPLOAD_IDLE_TIMEOUT_MS / 1000}s without activity`));
  });

  const [sent, responded] = await Promise.allSettled([
    pipeline(streamFile(file), req),
    once(req, 'response') as Promise<[IncomingMessage]>,
  ]);

  // An early response (e.g. 401) wins over the write error caused by the server closing the socket.
  if (responded.status === 'rejected') {
    throw sent.status === 'rejected' ? sent.reason : responded.reason;
  }

  const [response] = responded.value;

  return { status: response.statusCode ?? 0, body: await text(response) };
};

const toProviderFile = (file: RemoteFile): ProviderFile => ({
  id: String(file.id),
  name: file.name,
  hash: file.hash,
});

class InfomaniakProvider implements BackupProvider {
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

  async #listRemoteFiles(folderId: number): Promise<RemoteFile[]> {
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

  async #deleteFileFromTrash(fileId: number): Promise<void> {
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

    this.#logger.debug(
      { fileId },
      'File deleted from trash successfully',
    );
  }

  async resolveDestination(path?: string): Promise<string | null> {
    const folderId = await this.#resolveFolderId(path);

    return folderId === null ? null : String(folderId);
  }

  async listFiles(destinationId: string): Promise<ProviderFile[]> {
    const files = await this.#listRemoteFiles(Number(destinationId));

    return files.map(toProviderFile);
  }

  // eslint-disable-next-line class-methods-use-this -- required by the BackupProvider interface
  async hashFile(file: File): Promise<string> {
    return computeFileHash(file);
  }

  async uploadFile(
    file: File,
    path?: string,
  ): Promise<void> {
    if (file.size > MAX_DIRECT_UPLOAD_SIZE) {
      throw new Error(
        `File is larger than 1 GiB (${file.size} bytes), which kDrive's direct upload does not support`,
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
        const response = await postFile(
          `${this.#baseV3}/${this.#driveId}/upload?${queryParams}`,
          this.#token,
          file,
        );

        if (response.status < 200 || response.status >= 300) {
          throw new HttpError(response.status, `Failed to initiate upload (HTTP ${response.status})`);
        }

        const parsedData: UploadResponse = JSON.parse(response.body);

        if (parsedData.result === 'error') {
          throw new HttpError(400, `Upload error: ${JSON.stringify(parsedData.error)}`);
        }

        return parsedData;
      },
      { isRetryable: isTransientError },
    );
  }

  async deleteFile(file: ProviderFile): Promise<void> {
    const fileId = Number(file.id);

    await this.#deleteFile(fileId);
    await this.#deleteFileFromTrash(fileId);
  }
}

export default InfomaniakProvider;
