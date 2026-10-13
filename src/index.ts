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

  logger.info('App starting');

  scheduler.init();

  logger.info({ nextRunTime: scheduler.nextRun() }, 'Next run');
};

main().catch((error) => {
  logger.error({ error }, 'Error in main execution');
  throw error;
});
