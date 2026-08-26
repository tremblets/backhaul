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

  uploadFile: (file: File, path?: string) => Promise<void>;

  deleteFile: (file: ProviderFile) => Promise<void>;
}
