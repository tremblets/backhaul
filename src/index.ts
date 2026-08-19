import bootstrap from '@/app';
import { env } from '@/env';
import createAppLogger from '@/logger';

const logger = createAppLogger({
  level: env.LOG_LEVEL,
  serverVersion: env.VERSION,
  environment: env.NODE_ENV,
});

const main = async () => {
  const scheduler = await bootstrap(logger);

  scheduler.init();

  logger.info({ nextRun: scheduler.nextRun() }, 'App starting');
};

main().catch((error) => {
  logger.error({ error }, 'Error in main execution');
  throw error;
});
