import { describe, expect, it } from "vitest";
import {
  isValidTransparentRedirectUrl,
  MAX_TRANSPARENT_REDIRECT_URL_LENGTH,
  TransparentRedirectValidationError,
  validateTransparentRedirectUrl,
} from "./transparent-redirect.js";

describe("validateTransparentRedirectUrl", () => {
  it("accepts a valid http URL", () => {
    expect(validateTransparentRedirectUrl("http://example.com/offer")).toBe(
      "http://example.com/offer",
    );
  });

  it("accepts a valid https URL with a query string", () => {
    expect(validateTransparentRedirectUrl("https://example.com/offer?x=1")).toBe(
      "https://example.com/offer?x=1",
    );
  });

  it("returns the same canonical string used for validation (single-parser guarantee)", () => {
    const result = validateTransparentRedirectUrl("HTTPS://Example.com/Path");
    expect(result).toBe(new URL("HTTPS://Example.com/Path").toString());
  });

  it.each([
    ["javascript:alert(1)", "javascript scheme"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["blob:https://example.com/uuid", "blob scheme"],
    ["ftp://example.com/file", "ftp scheme"],
    ["custom-scheme://x", "custom scheme"],
    ["not a url", "malformed URL"],
    ["https://user:pass@example.com/", "userinfo"],
    ["//evil.com/path", "protocol-relative URL"],
    ["java\tscript:alert(1)", "tab-obfuscated dangerous scheme"],
    ["%6a%61%76%61%73%63%72%69%70%74:alert(1)", "percent-encoded dangerous scheme"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["https://example.com/\r\nSet-Cookie: evil=1", "CRLF injection attempt"],
    ["https://example.com:99999/", "invalid port"],
    ["a".repeat(MAX_TRANSPARENT_REDIRECT_URL_LENGTH + 1), "extremely long URL"],
    ["https://" + "a".repeat(MAX_TRANSPARENT_REDIRECT_URL_LENGTH), "extremely long valid-looking URL"],
  ])("rejects %s (%s)", (input) => {
    expect(() => validateTransparentRedirectUrl(input)).toThrow(TransparentRedirectValidationError);
  });

  it("never lets a control character survive into the returned URL", () => {
    expect(() => validateTransparentRedirectUrl("https://example.com/\r\nfoo")).toThrow(
      TransparentRedirectValidationError,
    );
  });
});

describe("isValidTransparentRedirectUrl", () => {
  it("returns true for a valid URL", () => {
    expect(isValidTransparentRedirectUrl("https://example.com")).toBe(true);
  });

  it("returns false for a dangerous scheme", () => {
    expect(isValidTransparentRedirectUrl("javascript:alert(1)")).toBe(false);
  });
});
