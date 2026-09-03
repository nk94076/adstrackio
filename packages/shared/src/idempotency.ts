import { createHash } from "node:crypto";

/**
 * Deterministically hashes a JSON-serializable value regardless of key
 * insertion order (Phase 11: API + Integrations) — used to detect whether
 * a replayed `Idempotency-Key` carries the exact same request payload as
 * the original, or a conflicting different one. See
 * docs/api/api-keys.md#idempotency.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}
