import { randomUUID } from "node:crypto";

/**
 * Cryptographically random, non-sequential click identifier. Generated
 * explicitly (rather than relying on Click.id's default cuid()) so it's
 * unambiguously a CSPRNG-backed value — used as the Click row's primary
 * key and for internal log correlation. Never appended to the outward
 * (Google-facing) redirect URL: the transparent redirect must not gain a
 * backend-only identifier hidden in it.
 */
export function generateClickId(): string {
  return randomUUID();
}
