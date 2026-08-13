import { loadConfig, secrets } from '@/config';
import InfomaniakUploader from '@/infomaniak.uploader';
import BackupScheduler from '@/scheduler';

const main = async () => {
  const config = await loadConfig();
  const uploader = new InfomaniakUploader({
    folderUrl: config.infomaniak.folderUrl,
    token: secrets.INFOMANIAK_API_KEY,
  });
  const scheduler = new BackupScheduler(
    uploader,
    config.folders,
    {
      schedule: config.schedule,
    },
  );

  scheduler.init();

  console.log(`App starting, next scheduled backup: ${scheduler.nextRun()}`)
};

main().catch((error) => {
  console.error('Error in main execution:', error);
  process.exit(1);
});
