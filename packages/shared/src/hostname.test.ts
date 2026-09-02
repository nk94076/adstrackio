import { describe, expect, it } from "vitest";
import {
  InvalidHostnameError,
  isValidTrackingHostname,
  normalizeTrackingHostname,
} from "./hostname.js";

describe("normalizeTrackingHostname", () => {
  it("lowercases and strips a trailing dot", () => {
    expect(normalizeTrackingHostname("TRACK.Example.COM.")).toBe("track.example.com");
  });

  it("accepts a plain multi-label hostname", () => {
    expect(normalizeTrackingHostname("track.example.com")).toBe("track.example.com");
  });

  it.each([
    ["https://track.example.com", "full URL"],
    ["https://track.example.com/path", "full URL with path"],
    ["track.example.com/foo", "path"],
    ["track.example.com?x=1", "query string"],
    ["track.example.com#frag", "fragment"],
    ["track.example.com:8080", "port"],
    ["user@track.example.com", "userinfo"],
    ["localhost", "bare localhost"],
    ["sub.localhost", "localhost subdomain"],
    ["127.0.0.1", "IPv4 loopback"],
    ["10.0.0.1", "IPv4 private range"],
    ["169.254.169.254", "IPv4 link-local (cloud metadata)"],
    ["::1", "IPv6 loopback"],
    ["-bad.example.com", "label starting with hyphen"],
    ["bad-.example.com", "label ending with hyphen"],
    ["example..com", "empty label"],
    ["example.123", "numeric top-level domain"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["a".repeat(260) + ".com", "too long"],
  ])("rejects %s (%s)", (hostname) => {
    expect(() => normalizeTrackingHostname(hostname)).toThrow(InvalidHostnameError);
  });
});

describe("isValidTrackingHostname", () => {
  it("returns true for a valid hostname", () => {
    expect(isValidTrackingHostname("track.example.com")).toBe(true);
  });

  it("returns false for an IP address", () => {
    expect(isValidTrackingHostname("127.0.0.1")).toBe(false);
  });
});
