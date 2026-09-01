import { envSchema, type Env } from "./schema.js";

export { envSchema, type Env };

export class EnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Validates a raw environment source (defaults to process.env) against the
 * shared schema. Throws EnvValidationError with a readable message instead
 * of letting the process crash with a raw Zod error.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Lazily validated, memoized environment accessor for long-running
 * processes. Prefer loadEnv() directly in tests to avoid cross-test caching.
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }
  return cachedEnv;
}
