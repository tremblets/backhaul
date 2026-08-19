import type { Logger } from 'pino';

import type { Retention } from '@/config';

export interface UploadFileOptions {
  retention?: Retention;
}

abstract class Provider {
  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  abstract uploadFile(
    file: File,
    path?: string,
    options?: UploadFileOptions,
  ): Promise<void>;
}

export default Provider;
