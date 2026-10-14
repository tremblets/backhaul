import type { Logger } from 'pino';

/**
 * First SIGTERM/SIGINT runs `shutdown` (graceful stop), a second one exits immediately.
 */
const handleShutdownSignals = (logger: Logger, shutdown: () => Promise<void>): void => {
  let stopping = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, 'Second signal received, exiting immediately');
      // eslint-disable-next-line n/no-process-exit -- forced exit is the point of a second signal
      process.exit(1);
    }

    stopping = true;
    logger.info({ signal }, 'Stopping: no new uploads, waiting for in-flight ones to finish');

    shutdown().catch((error: unknown) => {
      logger.error({ error }, 'Error during shutdown');
    });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
};

export default handleShutdownSignals;
