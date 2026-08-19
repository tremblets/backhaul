import bootstrap from '@/app';
import { env } from '@/env';

const main = async () => {
  const scheduler = await bootstrap();

  scheduler.init();

  console.log(`App starting, version: ${env.VERSION}, next scheduled backup: ${scheduler.nextRun()}`);
};

main().catch((error) => {
  console.error('Error in main execution:', error);
  throw error;
});
