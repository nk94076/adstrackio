import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Exact field names that must never appear unredacted in logs. pino/fast-redact
 * paths match a literal property name per path segment, not a substring —
 * "token" does NOT catch a key named "verificationToken" — so a new
 * sensitive field needs its own exact entry here rather than assuming an
 * existing entry's name covers it. Matched at up to two levels of nesting
 * via the wildcard paths generated below (`*.<key>`, `*.*.<key>`); a field
 * sensitive enough to log needs to be nested no deeper than that for this
 * to catch it.
 */
const SENSITIVE_KEYS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "verificationToken",
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
