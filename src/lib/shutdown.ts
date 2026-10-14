import type { Logger } from 'pino';

interface ShutdownHandlers {
  /** Graceful stop: lets in-flight uploads finish. */
  shutdown: () => Promise<void>;
  /** Forced stop: cancels in-flight uploads so the process can exit on its own. */
  cancel: () => void;
}

/**
 * First SIGTERM/SIGINT runs `shutdown`, a second one runs `cancel` and sets the exit code to 1.
 */
const handleShutdownSignals = (logger: Logger, { shutdown, cancel }: ShutdownHandlers): void => {
  let stopping = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, 'Second signal received, cancelling in-flight uploads');
      process.exitCode = 1;
      cancel();
      return;
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
