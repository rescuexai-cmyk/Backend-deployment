import winston from 'winston';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Console format for Docker logs - more readable
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${service}] ${level}: ${message}${metaStr}`;
  })
);

export function createLogger(serviceName: string) {
  const transports: winston.transport[] = [
    // Always log to console for Docker to capture
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ];

  // Only add file transports if not in Docker/production (optional)
  if (process.env.LOG_TO_FILE === 'true') {
    transports.push(
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' })
    );
  }

  return winston.createLogger({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format: logFormat,
    defaultMeta: { service: serviceName },
    transports,
  });
}

// Default logger for services that don't pass a name
export const logger = createLogger(process.env.SERVICE_NAME || 'raahi-backend');
