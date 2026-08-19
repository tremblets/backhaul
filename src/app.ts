import { loadConfig, resolveFolders } from '@/config';
import InfomaniakProvider from '@/providers/infomaniak.provider';
import BackupScheduler from '@/scheduler';
import { loadSecrets } from '@/secrets';

import type { Logger } from 'pino';

const bootstrap = async (logger: Logger): Promise<BackupScheduler> => {
  const [config, secrets] = await Promise.all([loadConfig(), loadSecrets()]);

  const uploader = new InfomaniakProvider(logger, {
    folderUrl: config.infomaniak.folderUrl,
    token: secrets.INFOMANIAK_API_KEY,
  });

  const entries = resolveFolders(config);

  const scheduler = new BackupScheduler(
    uploader,
    logger,
    entries,
    {
      schedule: config.schedule,
    },
  );

  return scheduler;
};

export default bootstrap;
