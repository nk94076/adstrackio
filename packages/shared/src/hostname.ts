import { isIP } from "node:net";

/**
 * Hostname normalization/validation for TrackingDomain records.
 *
 * A tracking domain must be a bare hostname the organization controls —
 * never a full URL, a path, or an IP literal. Accepting anything looser
 * here would let a client smuggle a scheme/path/query/port into a field
 * that DNS verification (and, in a future phase, routing) treats as a
 * plain hostname; this stays intentionally strict rather than "lenient and
 * strip the extra parts", since silently stripping could itself lead a
 * caller to believe a different value was accepted than what actually was.
 */

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

export class InvalidHostnameError extends Error {
  constructor(reason: string) {
    super(`Invalid hostname: ${reason}`);
    this.name = "InvalidHostnameError";
  }
}

/**
 * Parses, validates, and canonicalizes a tracking domain hostname.
 * - Rejects anything that isn't a bare hostname: a scheme, userinfo, path,
 *   query, fragment, or port makes the input invalid rather than being
 *   stripped away.
 * - Rejects IP literals (IPv4 and IPv6) — a tracking domain must be a real
 *   DNS name so a TXT-record lookup can verify ownership of it.
 * - Rejects "localhost" and any ".localhost" subdomain.
 * - Lower-cases the hostname and strips a single trailing dot (the DNS
 *   root label separator, harmless to drop since it's not part of the
 *   registrable hostname).
 *
 * Throws InvalidHostnameError on anything that doesn't qualify.
 */
export function normalizeTrackingHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidHostnameError("hostname is empty");
  }

  if (/[/?#@\s]/.test(trimmed) || trimmed.includes("://")) {
    throw new InvalidHostnameError(
      "hostname must not contain a scheme, path, query, or fragment",
    );
  }

  if (trimmed.includes(":")) {
    throw new InvalidHostnameError("hostname must not include a port");
  }

  let hostname = trimmed.toLowerCase();
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }
  if (!hostname) {
    throw new InvalidHostnameError("hostname is empty");
  }

  if (isIP(hostname) !== 0) {
    throw new InvalidHostnameError("hostname must not be an IP address");
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new InvalidHostnameError("localhost is not allowed");
  }

  if (hostname.length > 253) {
    throw new InvalidHostnameError("hostname is too long");
  }

  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new InvalidHostnameError("hostname is not a valid domain name");
  }

  const labels = hostname.split(".");
  const topLevelLabel = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(topLevelLabel)) {
    throw new InvalidHostnameError("hostname must not have a numeric top-level domain");
  }

  return hostname;
}

export function isValidTrackingHostname(input: string): boolean {
  try {
    normalizeTrackingHostname(input);
    return true;
  } catch {
    return false;
  }
}
