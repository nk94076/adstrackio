import { describe, expect, it } from "vitest";
import { extractCountrySignal, extractReferrerHost } from "./routing-signals.js";

describe("extractCountrySignal", () => {
  it("returns null when no known geo header is present", () => {
    expect(extractCountrySignal({})).toBeNull();
  });

  it("reads cf-ipcountry (Cloudflare)", () => {
    expect(extractCountrySignal({ "cf-ipcountry": "us" })).toBe("US");
  });

  it("reads x-vercel-ip-country (Vercel)", () => {
    expect(extractCountrySignal({ "x-vercel-ip-country": "GB" })).toBe("GB");
  });

  it("reads cloudfront-viewer-country (AWS CloudFront)", () => {
    expect(extractCountrySignal({ "cloudfront-viewer-country": "de" })).toBe("DE");
  });

  it("prefers cf-ipcountry when multiple are present", () => {
    expect(
      extractCountrySignal({ "cf-ipcountry": "US", "x-vercel-ip-country": "GB" }),
    ).toBe("US");
  });

  it("treats a malformed value (not 2-letter alpha) as absent", () => {
    expect(extractCountrySignal({ "cf-ipcountry": "XX1" })).toBeNull();
    expect(extractCountrySignal({ "cf-ipcountry": "" })).toBeNull();
    expect(extractCountrySignal({ "cf-ipcountry": "USA" })).toBeNull();
  });

  it("takes the first value when a header is duplicated into an array", () => {
    expect(extractCountrySignal({ "cf-ipcountry": ["US", "GB"] })).toBe("US");
  });

  it("never throws on unexpected header shapes", () => {
    expect(() => extractCountrySignal({ "cf-ipcountry": undefined })).not.toThrow();
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
