import pino from 'pino';

import type {
  DestinationStream, Level, Logger, LoggerOptions,
} from 'pino';

interface AppLoggerOptions {
  level: Level;
  environment: string;
  serverVersion: string;
  destination?: DestinationStream;
}

function createAppLogger(options: AppLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    // timestamp: pino.stdTimeFunctions.isoTime,
    timestamp: false,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      error: pino.stdSerializers.err,
    },
    // base: {
    //   service: 'kdrive-backup',
    //   version: options.serverVersion,
    //   environment: options.environment,
    // },
  };

  return pino(loggerOptions, options.destination);
}

export default createAppLogger;
