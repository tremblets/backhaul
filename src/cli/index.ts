#!/usr/bin/env node

import { Command } from 'commander';

import bootstrap from '@/app';
import { env } from '@/env';
import handleShutdownSignals from '@/lib/shutdown';
import createAppLogger from '@/logger';
import { isSuccessful } from '@/scheduler';

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

      handleShutdownSignals(logger, {
        shutdown: async () => scheduler.shutdown(),
        cancel: () => scheduler.cancel(),
      });

      const result = await scheduler.runBackup();

      if (!isSuccessful(result)) {
        process.exitCode = 1;
      }
    } catch (error) {
      logger.error({ error }, 'Error during manual backup');
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
