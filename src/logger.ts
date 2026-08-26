import pino from 'pino';

import type {
  DestinationStream, Level, Logger, LoggerOptions,
} from 'pino';

const SERVICE_NAME = 'backhaul';

interface AppLoggerOptions {
  level: Level;
  environment: string;
  serverVersion: string;
  destination?: DestinationStream;
}

function createAppLogger(options: AppLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: {
      service: SERVICE_NAME,
      version: options.serverVersion,
      environment: options.environment,
    },
    transport: options.environment === 'development' && !options.destination
      ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }
      : undefined,
  };

  return pino(loggerOptions, options.destination);
}

export default createAppLogger;
