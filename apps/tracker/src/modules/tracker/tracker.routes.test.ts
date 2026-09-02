import { describe, expect, it } from "vitest";
import { normalizeRequestHostname } from "./tracker.routes.js";

/**
 * Unit tests for the pure Host-header normalization helper. Full HTTP-level
 * routing behavior (domain/link resolution, bot routing, etc.) is covered
 * by the real-Postgres integration suite in
 * apps/tracker/test/tracker.routes.test.ts — this file only exercises the
 * string-parsing logic in isolation.
 */
describe("normalizeRequestHostname", () => {
  it("lowercases a plain hostname", () => {
    expect(normalizeRequestHostname("Track.Example.com")).toBe("track.example.com");
  });

  it("strips a port from a plain hostname", () => {
    expect(normalizeRequestHostname("track.example.com:8443")).toBe("track.example.com");
  });

  it("leaves a plain hostname without a port unchanged (other than lowercasing)", () => {
    expect(normalizeRequestHostname("track.example.com")).toBe("track.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRequestHostname("  track.example.com  ")).toBe("track.example.com");
  });

  describe("bracketed IPv6 literals", () => {
    it("keeps a bare IPv6 literal's brackets intact", () => {
      expect(normalizeRequestHostname("[::1]")).toBe("[::1]");
    });

    it("strips a trailing port from a bracketed IPv6 literal without mangling the address", () => {
      expect(normalizeRequestHostname("[::1]:8443")).toBe("[::1]");
    });

    it("handles a full, multi-colon IPv6 address correctly", () => {
      expect(normalizeRequestHostname("[2001:db8::1]:3000")).toBe("[2001:db8::1]");
    });

    it("lowercases a bracketed IPv6 literal", () => {
      expect(normalizeRequestHostname("[2001:DB8::FF]")).toBe("[2001:db8::ff]");
    });

    it("falls back to plain-hostname handling for a malformed bracket (no closing ']') without throwing", () => {
      expect(() => normalizeRequestHostname("[::1")).not.toThrow();
      // Never matches a real TrackingDomain either way (IP literals are
      // rejected at domain creation) — the exact fallback value isn't
      // load-bearing, only that it doesn't throw.
    });
  });
});
