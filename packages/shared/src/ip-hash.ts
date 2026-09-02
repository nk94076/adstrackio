import { createHash } from "node:crypto";

/**
 * One-way, salted hash of a client IP address. Used by apps/tracker so a
 * raw IP is never persisted on a Click row (see Click.ipHash in the
 * schema) — only this hash, which cannot be reversed and is not usable to
 * correlate a click back to a specific IP without also knowing the salt.
 */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}
