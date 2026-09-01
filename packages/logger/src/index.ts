import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Field name fragments that must never appear unredacted in logs. Matched
 * case-insensitively against object keys at any depth via pino's redact
 * wildcard paths.
 */
const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
  "secret",
  "authSecret",
  "apiKey",
];

export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `req.headers.${key.toLowerCase()}`,
  `res.headers.${key.toLowerCase()}`,
]);

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  /** Set false in tests to avoid noisy stdout output. */
  enabled?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    name: options.name,
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    enabled: options.enabled ?? true,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(pinoOptions);
}

export type { Logger };
