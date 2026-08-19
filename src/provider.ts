import InfomaniakProvider from '@/providers/infomaniak.provider';

import type { Logger } from 'pino';

import type { Config } from '@/config';
import type Provider from '@/providers/provider';

const createProvider = (
  config: Config,
  token: string,
  logger: Logger,
): Provider => new InfomaniakProvider(logger, {
  folderUrl: config.infomaniak.folderUrl,
  token,
});

export default createProvider;
