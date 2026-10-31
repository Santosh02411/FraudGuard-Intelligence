/**
 * Structured logging (Winston) — replaces console.log/warn/error across
 * the app. Log SHAPE depends on environment (config/env.js):
 *
 *   - development — colorized, human-readable single-line output, good
 *     for a terminal you're actively watching.
 *   - staging/production/test — structured JSON, one object per line —
 *     what you actually want when logs are shipped to something that
 *     parses them (CloudWatch, Datadog, ELK, etc), not read by a human
 *     scrolling a terminal.
 *
 * Usage: `const logger = require('../config/logger'); logger.info('message', { extra: 'fields' })`
 */

const winston = require('winston');
const config = require('./env');

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    delete meta.service;
    delete meta.env;
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} ${level}: ${stack || message}${metaStr}`;
  })
);

const structuredFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: config.logLevel,
  format: config.isDev ? devFormat : structuredFormat,
  defaultMeta: { service: 'fraudguard-backend', env: config.env },
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

module.exports = logger;
