import winston from 'winston';

export function createLogger(level: string): winston.Logger {
  const format = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  );

  const logger = winston.createLogger({
    level,
    format,
    defaultMeta: { service: 'contract-deployer' },
    transports: [
      new winston.transports.Console({
        format:
          process.env.NODE_ENV === 'production'
            ? winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json(),
              )
            : winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
                winston.format.printf((info) => {
                  const { timestamp, level, message, ...extra } = info;
                  const ts = timestamp as string;
                  const extraStr = Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
                  return `${ts} [${level}]: ${message} ${extraStr}`;
                }),
              ),
      }),
    ],
  });

  // Don't add file transports in production ECS environment
  // Logs are captured by CloudWatch through stdout/stderr
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_FILE_LOGGING === 'true') {
    logger.add(
      new winston.transports.File({
        filename: 'error.log',
        level: 'error',
      }),
    );
    logger.add(
      new winston.transports.File({
        filename: 'combined.log',
      }),
    );
  }

  return logger;
}

export const logger = createLogger(process.env.LOG_LEVEL || 'info');