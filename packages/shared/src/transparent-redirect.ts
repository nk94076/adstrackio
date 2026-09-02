/**
 * URL validation for the tracker's transparent redirect parameter
 * (`redirection_url`) — Phase 3 (Transparent Click Tracker).
 *
 * This is deliberately a SEPARATE validator from `normalizeDestinationUrl`
 * (url.ts), even though both ultimately restrict to http(s), because the
 * two solve different problems with different trust boundaries:
 *   - normalizeDestinationUrl validates a URL an authenticated org member
 *     configures in advance (a Destination/Campaign safe page).
 *   - validateTransparentRedirectUrl validates a URL supplied by an
 *     anonymous request, on every hit, as the visible "immediate next hop"
 *     the Google Transparent Click Tracker architecture requires — see
 *     docs/compliance/google-transparent-tracker.md. It has to be stricter
 *     (e.g. no userinfo) and is checked on a much hotter path.
 *
 * Design rule enforced by this module: validate and redirect using the
 * SAME parsed URL object. A prior open-redirect/SSRF class of bug is two
 * different parsers (or a regex check vs. a URL parse) disagreeing about
 * what the "real" host/scheme is. Callers must redirect to the exact
 * string this function returns, not re-derive one from the raw input.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Generous but bounded — long enough for any real tracking URL with UTM
 * params, short enough to reject pathological input before it's parsed. */
export const MAX_TRANSPARENT_REDIRECT_URL_LENGTH = 2048;

export class TransparentRedirectValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid redirection_url: ${reason}`);
    this.name = "TransparentRedirectValidationError";
  }
}

/**
 * Parses and validates a transparent-redirect destination URL, returning
 * the canonical string to redirect to. Throws
 * TransparentRedirectValidationError on anything that doesn't qualify.
 *
 * - Requires an absolute http(s) URL.
 * - Rejects dangerous/non-http(s) schemes (javascript:, data:, file:,
 *   blob:, ftp:, custom schemes, ...).
 * - Rejects userinfo (`user:pass@host`) — never justified for a tracking
 *   redirect target.
 * - Rejects raw CR/LF or other ASCII control characters in the input
 *   outright, rather than relying on the URL parser to silently strip
 *   them — a rejected request is safer than one that "worked" via
 *   undocumented parser normalization.
 * - Rejects input over MAX_TRANSPARENT_REDIRECT_URL_LENGTH before parsing.
 */
export function validateTransparentRedirectUrl(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new TransparentRedirectValidationError("redirection_url is required");
  }

  if (input.length > MAX_TRANSPARENT_REDIRECT_URL_LENGTH) {
    throw new TransparentRedirectValidationError(
      `redirection_url exceeds the maximum length of ${MAX_TRANSPARENT_REDIRECT_URL_LENGTH} characters`,
    );
  }

  // eslint-disable-next-line no-control-regex -- deliberately scanning for control chars
  if (/[\x00-\x1f\x7f]/.test(input)) {
    throw new TransparentRedirectValidationError(
      "redirection_url must not contain control characters",
    );
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new TransparentRedirectValidationError("redirection_url is required");
  }

  if (trimmed.startsWith("//")) {
    throw new TransparentRedirectValidationError("redirection_url must not be protocol-relative");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TransparentRedirectValidationError("redirection_url is not a well-formed URL");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new TransparentRedirectValidationError(
      `protocol "${parsed.protocol}" is not allowed (only http/https)`,
    );
  }

  if (!parsed.hostname) {
    throw new TransparentRedirectValidationError("redirection_url is missing a hostname");
  }

  if (parsed.username || parsed.password) {
    throw new TransparentRedirectValidationError("redirection_url must not contain userinfo");
  }

  return parsed.toString();
}

export function isValidTransparentRedirectUrl(input: string): boolean {
  try {
    validateTransparentRedirectUrl(input);
    return true;
  } catch {
    return false;
  }
}
