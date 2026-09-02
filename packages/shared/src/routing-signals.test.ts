import { describe, expect, it } from "vitest";
import {
  TRUSTED_EDGE_SECRET_HEADER,
  extractCountrySignal,
  extractReferrerHost,
  isTrustedEdgeRequest,
} from "./routing-signals.js";

const SECRET = "a-very-long-trusted-edge-secret-value";

describe("isTrustedEdgeRequest", () => {
  it("is false when no TRUSTED_EDGE_SECRET is configured, regardless of headers", () => {
    expect(isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: SECRET }, undefined)).toBe(false);
  });

  it("is false when the secret header is absent", () => {
    expect(isTrustedEdgeRequest({}, SECRET)).toBe(false);
  });

  it("is false when the secret header value does not match", () => {
    expect(isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: "wrong-value" }, SECRET)).toBe(false);
  });

  it("is false when the secret header value is a different length than the configured secret", () => {
    expect(isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: "short" }, SECRET)).toBe(false);
    expect(
      isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: SECRET + "-extra" }, SECRET),
    ).toBe(false);
  });

  it("is false for an empty-string header value even if the configured secret happens to be falsy-adjacent", () => {
    expect(isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: "" }, SECRET)).toBe(false);
  });

  it("is true when the secret header value exactly matches the configured secret", () => {
    expect(isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: SECRET }, SECRET)).toBe(true);
  });

  it("takes the first value when the secret header is duplicated into an array, and still requires an exact match", () => {
    expect(
      isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: [SECRET, "other"] }, SECRET),
    ).toBe(true);
    expect(
      isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: ["wrong", SECRET] }, SECRET),
    ).toBe(false);
  });

  it("never throws on unexpected header shapes", () => {
    expect(() => isTrustedEdgeRequest({ [TRUSTED_EDGE_SECRET_HEADER]: undefined }, SECRET)).not.toThrow();
  });
});

describe("extractCountrySignal — spoofing resistance (PR #9 review finding)", () => {
  it("a direct request with cf-ipcountry set and NO trusted-edge secret configured resolves to null", () => {
    expect(extractCountrySignal({ "cf-ipcountry": "US" }, undefined)).toBeNull();
  });

  it("a direct request with x-vercel-ip-country set and NO trusted-edge secret configured resolves to null", () => {
    expect(extractCountrySignal({ "x-vercel-ip-country": "US" }, undefined)).toBeNull();
  });

  it("a direct request with cloudfront-viewer-country set and NO trusted-edge secret configured resolves to null", () => {
    expect(extractCountrySignal({ "cloudfront-viewer-country": "US" }, undefined)).toBeNull();
  });

  it("a client that spoofs cf-ipcountry AND guesses the secret header name, but not its value, still resolves to null", () => {
    expect(
      extractCountrySignal(
        { "cf-ipcountry": "US", [TRUSTED_EDGE_SECRET_HEADER]: "attacker-guess" },
        SECRET,
      ),
    ).toBeNull();
  });

  it("a real geo header on an otherwise-trusted-edge-configured deployment still resolves to null without the matching secret on THIS request", () => {
    // TRUSTED_EDGE_SECRET is configured server-side, but this particular
    // request (e.g. one that reached the origin directly, bypassing the
    // CDN) carries no secret header at all.
    expect(extractCountrySignal({ "cf-ipcountry": "US" }, SECRET)).toBeNull();
  });

  it("resolves the country when the request carries the exact matching trusted-edge secret alongside a well-formed geo header", () => {
    expect(
      extractCountrySignal({ "cf-ipcountry": "us", [TRUSTED_EDGE_SECRET_HEADER]: SECRET }, SECRET),
    ).toBe("US");
  });

  it("prefers cf-ipcountry over the other geo headers once trusted", () => {
    expect(
      extractCountrySignal(
        {
          "cf-ipcountry": "US",
          "x-vercel-ip-country": "GB",
          [TRUSTED_EDGE_SECRET_HEADER]: SECRET,
        },
        SECRET,
      ),
    ).toBe("US");
  });

  it("treats a malformed value (not 2-letter alpha) as absent even once trusted", () => {
    expect(
      extractCountrySignal({ "cf-ipcountry": "XX1", [TRUSTED_EDGE_SECRET_HEADER]: SECRET }, SECRET),
    ).toBeNull();
    expect(
      extractCountrySignal({ "cf-ipcountry": "USA", [TRUSTED_EDGE_SECRET_HEADER]: SECRET }, SECRET),
    ).toBeNull();
  });

  it("never throws on unexpected header shapes", () => {
    expect(() => extractCountrySignal({ "cf-ipcountry": undefined }, SECRET)).not.toThrow();
  });
});

describe("extractReferrerHost", () => {
  it("returns null when referrer is undefined", () => {
    expect(extractReferrerHost(undefined)).toBeNull();
  });

  it("extracts and lowercases the hostname from a valid URL", () => {
    expect(extractReferrerHost("https://Example.COM/some/path?x=1")).toBe("example.com");
  });

  it("returns null for a malformed URL rather than throwing", () => {
    expect(extractReferrerHost("not a url")).toBeNull();
    expect(extractReferrerHost("")).toBeNull();
  });
});
