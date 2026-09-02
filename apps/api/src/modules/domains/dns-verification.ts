import { randomBytes } from "node:crypto";
import { resolveTxt as nodeResolveTxt } from "node:dns/promises";

/**
 * DNS TXT-record domain ownership verification.
 *
 * Deliberately DNS-only: this never makes an HTTP request to a
 * client-controlled URL, so there is no SSRF surface here — the only
 * network call is a standard DNS TXT lookup for a name derived from the
 * domain's own (already-validated) hostname, resolved through Node's
 * built-in resolver.
 */

const VERIFICATION_SUBDOMAIN = "_adstrackio-verification";
const VERIFICATION_VALUE_PREFIX = "adstrackio-domain-verification=";

/** A cryptographically random, URL-safe verification token. */
export function generateVerificationToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The DNS TXT record name the customer must create for a given hostname. */
export function verificationRecordName(hostname: string): string {
  return `${VERIFICATION_SUBDOMAIN}.${hostname}`;
}

/** The exact TXT record value the customer must publish. */
export function verificationRecordValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`;
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;

/**
 * Performs the actual server-side check: looks up the TXT record and
 * compares it against the expected value for `token`. Returns false (never
 * throws) on any DNS failure — a missing record, NXDOMAIN, timeout, etc.
 * are all "not verified yet", not an application error.
 *
 * `resolveTxt` is injectable so tests can verify both outcomes without
 * depending on real external DNS infrastructure.
 */
export async function checkDnsVerification(
  hostname: string,
  token: string,
  resolveTxt: TxtResolver = nodeResolveTxt,
): Promise<boolean> {
  const expected = verificationRecordValue(token);
  try {
    const records = await resolveTxt(verificationRecordName(hostname));
    return records.some((chunks) => chunks.join("") === expected);
  } catch {
    return false;
  }
}
