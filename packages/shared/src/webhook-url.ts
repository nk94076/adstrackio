import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * SSRF-safe validation for organization-supplied webhook destination URLs
 * (Phase 11: API + Integrations) — see docs/api/webhooks.md#ssrf-protection.
 *
 * A webhook URL is fundamentally different from every other URL this
 * codebase validates (Destination, safePageUrl): it is a destination the
 * SERVER itself makes an outbound HTTP request to, on a schedule the
 * organization doesn't control (every delivery/retry), so a malicious or
 * compromised organization could otherwise point it at the API server's
 * own internal network (a database admin panel, a cloud metadata
 * endpoint, another internal service with no auth of its own) and use
 * AdstrackIO's server as a network proxy into infrastructure it has no
 * business reaching. `normalizeDestinationUrl` (url.ts) — format/protocol
 * validation only — is necessary but not sufficient here.
 */
export class UnsafeWebhookUrlError extends Error {
  constructor(reason: string) {
    super(`Unsafe webhook URL: ${reason}`);
    this.name = "UnsafeWebhookUrlError";
  }
}

const disallowedRanges = new BlockList();
// IPv4: loopback, link-local (includes the 169.254.169.254 cloud metadata
// endpoint every major cloud provider uses), RFC1918 private ranges,
// carrier-grade NAT, IETF/documentation/test-net reservations, multicast,
// reserved, and the broadcast address.
disallowedRanges.addSubnet("0.0.0.0", 8, "ipv4");
disallowedRanges.addSubnet("10.0.0.0", 8, "ipv4");
disallowedRanges.addSubnet("100.64.0.0", 10, "ipv4");
disallowedRanges.addSubnet("127.0.0.0", 8, "ipv4");
disallowedRanges.addSubnet("169.254.0.0", 16, "ipv4");
disallowedRanges.addSubnet("172.16.0.0", 12, "ipv4");
disallowedRanges.addSubnet("192.0.0.0", 24, "ipv4");
disallowedRanges.addSubnet("192.0.2.0", 24, "ipv4");
disallowedRanges.addSubnet("192.168.0.0", 16, "ipv4");
disallowedRanges.addSubnet("198.18.0.0", 15, "ipv4");
disallowedRanges.addSubnet("198.51.100.0", 24, "ipv4");
disallowedRanges.addSubnet("203.0.113.0", 24, "ipv4");
disallowedRanges.addSubnet("224.0.0.0", 4, "ipv4");
disallowedRanges.addSubnet("240.0.0.0", 4, "ipv4");
disallowedRanges.addAddress("255.255.255.255", "ipv4");
// IPv6: unspecified, loopback, unique-local, link-local, documentation,
// multicast.
disallowedRanges.addAddress("::", "ipv6");
disallowedRanges.addAddress("::1", "ipv6");
disallowedRanges.addSubnet("fc00::", 7, "ipv6");
disallowedRanges.addSubnet("fe80::", 10, "ipv6");
disallowedRanges.addSubnet("2001:db8::", 32, "ipv6");
disallowedRanges.addSubnet("ff00::", 8, "ipv6");

/** Unwraps an IPv4-mapped IPv6 address ("::ffff:127.0.0.1") to its
 * embedded IPv4 form, so it can't sneak past the IPv4 checks above by
 * being spelled as IPv6. Returns null for anything else. */
function unwrapIpv4MappedIpv6(address: string): string | null {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return match ? match[1]! : null;
}

function isDisallowedAddress(address: string): boolean {
  const mapped = unwrapIpv4MappedIpv6(address);
  if (mapped) {
    return disallowedRanges.check(mapped, "ipv4");
  }
  const family = isIP(address);
  if (family === 4) {
    return disallowedRanges.check(address, "ipv4");
  }
  if (family === 6) {
    return disallowedRanges.check(address, "ipv6");
  }
  // Not a literal IP at all — caller only ever passes us resolved
  // addresses or IP literals, so this should be unreachable; fail closed.
  return true;
}

export interface ValidateWebhookUrlOptions {
  /** Reject plain http:// URLs. Should be true in production — see
   * docs/api/webhooks.md#ssrf-protection. */
  requireHttps: boolean;
  /** Injectable for tests; defaults to the real DNS resolver. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface ValidatedWebhookUrl {
  /** Normalized (lower-cased host) URL string, safe to persist. */
  url: string;
  hostname: string;
  /**
   * Every address `hostname` resolved to at validation time, each already
   * confirmed public/non-internal. This is a snapshot, not a live lookup
   * — DNS is not guaranteed to answer the same way a moment later (a
   * DNS-rebinding attack deliberately exploits that gap). The actual HTTP
   * client making the delivery MUST connect to one of these addresses
   * directly (e.g. via a custom `lookup` option that returns this pinned
   * list) rather than re-resolving the hostname itself at connect time —
   * otherwise this whole check can be bypassed by an attacker who
   * controls DNS and simply waits for the real request. See
   * apps/api/src/modules/webhooks/webhook-http-client.ts.
   */
  resolvedAddresses: string[];
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    return [hostname];
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Validates a webhook endpoint URL is safe to store and to later deliver
 * to. Throws UnsafeWebhookUrlError with a specific, non-leaky reason on
 * any failure.
 *
 * Checks performed:
 * 1. Well-formed absolute URL with an http/https scheme (https required
 *    when `requireHttps`).
 * 2. Resolves the hostname (or accepts an IP literal directly) and
 *    rejects if ANY resolved address falls in a private/loopback/
 *    link-local/reserved/metadata range — an attacker only needs one of
 *    several DNS answers to be internal for a rebinding attack to work,
 *    so every answer must be public, not just the first.
 *
 * Known limitation: this validates DNS state at write time (endpoint
 * creation/update/test-send). The actual delivery, some time later, must
 * independently pin its connection to the addresses returned here (not
 * re-resolve) to fully close the TOCTOU DNS-rebinding window — see
 * `ValidatedWebhookUrl.resolvedAddresses`'s doc comment. This function
 * cannot itself guarantee what a hostname will resolve to at a future
 * delivery time if the caller doesn't use the pinned addresses it
 * returns.
 */
export async function validateWebhookUrl(
  input: string,
  options: ValidateWebhookUrlOptions,
): Promise<ValidatedWebhookUrl> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new UnsafeWebhookUrlError("URL is empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UnsafeWebhookUrlError("URL is not well-formed");
  }

  const allowedProtocols = options.requireHttps ? ["https:"] : ["https:", "http:"];
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new UnsafeWebhookUrlError(
      options.requireHttps
        ? "URL must use https:// in production"
        : `Protocol "${parsed.protocol}" is not allowed`,
    );
  }

  if (!parsed.hostname) {
    throw new UnsafeWebhookUrlError("URL is missing a hostname");
  }
  if (parsed.hostname.toLowerCase() === "localhost") {
    throw new UnsafeWebhookUrlError("localhost is not a permitted webhook destination");
  }

  parsed.hostname = parsed.hostname.toLowerCase();

  const resolve = options.resolveHostname ?? defaultResolveHostname;
  let addresses: string[];
  try {
    addresses = await resolve(parsed.hostname);
  } catch {
    throw new UnsafeWebhookUrlError("Hostname could not be resolved");
  }
  if (addresses.length === 0) {
    throw new UnsafeWebhookUrlError("Hostname did not resolve to any address");
  }
  if (addresses.some(isDisallowedAddress)) {
    throw new UnsafeWebhookUrlError(
      "Hostname resolves to a private, loopback, link-local, or otherwise internal address",
    );
  }

  return { url: parsed.toString(), hostname: parsed.hostname, resolvedAddresses: addresses };
}
