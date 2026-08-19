import { loadConfig, resolveFolders } from '@/config';
import { env } from '@/env';
import createAppLogger from '@/logger';
import InfomaniakProvider from '@/providers/infomaniak.provider';
import BackupScheduler from '@/scheduler';
import { loadSecrets } from '@/secrets';

const bootstrap = async (): Promise<BackupScheduler> => {
  const [config, secrets] = await Promise.all([loadConfig(), loadSecrets()]);
  const logger = createAppLogger({
    level: env.LOG_LEVEL,
    serverVersion: env.VERSION,
    environment: env.NODE_ENV,
  });
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
