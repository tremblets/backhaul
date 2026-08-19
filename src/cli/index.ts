#!/usr/bin/env node

import { Command } from 'commander';

import bootstrap from '@/app';
import { env } from '@/env';
import createAppLogger from '@/logger';

const logger = createAppLogger({
  level: env.LOG_LEVEL,
  serverVersion: env.VERSION,
  environment: env.NODE_ENV,
});

const program = new Command();

program
  .name('backup')
  .version(env.VERSION);

program
  .command('start')
  .description('Start manual backup')
  .action(async () => {
    try {
      logger.info('Starting manual backup');
      const scheduler = await bootstrap(logger);

      await scheduler.runBackup();
    } catch (error) {
      logger.error({ error }, 'Error during manual backup');
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
