/**
 * URL normalization/validation for Destination records.
 *
 * Scope note: this validates and canonicalizes URLs that an authenticated
 * organization member explicitly configures as a business destination. It
 * is NOT a general-purpose redirect helper and must never be used to build
 * a "redirect to whatever URL the request contains" endpoint — that would
 * be an open redirect. The future transparent click tracker resolves a
 * TrackingLink to its pre-configured Destination only; see
 * docs/compliance/google-transparent-tracker.md.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class InvalidDestinationUrlError extends Error {
  constructor(reason: string) {
    super(`Invalid destination URL: ${reason}`);
    this.name = "InvalidDestinationUrlError";
  }
}

/**
 * Parses, validates, and canonicalizes a destination URL.
 * - Requires an absolute http(s) URL.
 * - Rejects dangerous schemes (javascript:, data:, file:, etc).
 * - Lower-cases the hostname and strips a trailing slash on a bare path.
 *
 * Throws InvalidDestinationUrlError on anything that doesn't qualify.
 */
export function normalizeDestinationUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidDestinationUrlError("URL is empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidDestinationUrlError("URL is not well-formed");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new InvalidDestinationUrlError(`Protocol "${parsed.protocol}" is not allowed`);
  }

  if (!parsed.hostname) {
    throw new InvalidDestinationUrlError("URL is missing a hostname");
  }

  parsed.hostname = parsed.hostname.toLowerCase();

  if (parsed.pathname === "") {
    parsed.pathname = "/";
  }

  return parsed.toString();
}

export function isValidDestinationUrl(input: string): boolean {
  try {
    normalizeDestinationUrl(input);
    return true;
  } catch {
    return false;
  }
}
