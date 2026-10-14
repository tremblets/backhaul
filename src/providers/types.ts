export interface ProviderFile {
  id: string;
  name: string;
  hash?: string;
}

export interface BackupProvider {
  readonly name: string;

  resolveDestination: (path?: string) => Promise<string | null>;

  listFiles: (destinationId: string) => Promise<ProviderFile[]>;

  hashFile: (file: File) => Promise<string>;

  /**
   * Once `signal` is aborted, a failed upload is no longer retried.
   * Aborting `cancelSignal` interrupts the upload in progress.
   */
  uploadFile: (
    file: File,
    path?: string,
    options?: { signal?: AbortSignal; cancelSignal?: AbortSignal },
  ) => Promise<void>;

  deleteFile: (file: ProviderFile) => Promise<void>;
}
