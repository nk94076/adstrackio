import { describe, expect, it } from "vitest";
import {
  InvalidDestinationUrlError,
  isValidDestinationUrl,
  normalizeDestinationUrl,
} from "./url.js";

describe("normalizeDestinationUrl", () => {
  it("normalizes hostname casing and adds a trailing slash for bare paths", () => {
    expect(normalizeDestinationUrl("https://Example.COM")).toBe("https://example.com/");
  });

  it("preserves query strings and paths", () => {
    expect(normalizeDestinationUrl("https://example.com/lp?utm_source=x")).toBe(
      "https://example.com/lp?utm_source=x",
    );
  });

  it("rejects javascript: URLs", () => {
    expect(() => normalizeDestinationUrl("javascript:alert(1)")).toThrow(
      InvalidDestinationUrlError,
    );
  });

  it("rejects data: URLs", () => {
    expect(() => normalizeDestinationUrl("data:text/html,<script>alert(1)</script>")).toThrow(
      InvalidDestinationUrlError,
    );
  });

  it("rejects malformed input", () => {
    expect(() => normalizeDestinationUrl("not a url")).toThrow(InvalidDestinationUrlError);
  });

  it("rejects an empty string", () => {
    expect(() => normalizeDestinationUrl("   ")).toThrow(InvalidDestinationUrlError);
  });
});

describe("isValidDestinationUrl", () => {
  it("returns true for a valid https URL", () => {
    expect(isValidDestinationUrl("https://example.com/offer")).toBe(true);
  });

  it("returns false for a disallowed scheme", () => {
    expect(isValidDestinationUrl("ftp://example.com")).toBe(false);
  });
});
