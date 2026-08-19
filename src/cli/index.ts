#!/usr/bin/env node

import { Command } from 'commander';

import bootstrap from '@/app';
import { env } from '@/env';

const program = new Command();

program
  .name('backup')
  .version(env.VERSION);

program
  .command('start')
  .description('Start manual backup')
  .action(async () => {
    try {
      console.log('Starting manual backup ...');
      const scheduler = await bootstrap();

      console.log('🚀 Lancement de la sauvegarde manuelle...');

      await scheduler.runBackup();
      process.exit(0);
    } catch (error) {
      console.error('❌ Erreur lors de l\'exécution de la sauvegarde :', error);
      process.exit(1);
    }
  });

program.parse(process.argv);
