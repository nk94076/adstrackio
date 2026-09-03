import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  extractApiKeyLookupPrefix,
  generateApiKey,
  hashApiKeySecret,
  verifyApiKeySecret,
} from "./api-key.js";

describe("generateApiKey", () => {
  it("produces a raw key with the expected prefix and a hash that cannot reconstruct it", () => {
    const generated = generateApiKey();
    expect(generated.raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).not.toBe(generated.raw);
    expect(generated.raw).not.toContain(generated.hash);
  });

  it("generates high-entropy, unique secrets — never a UUID or predictable value", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.prefix).not.toBe(b.prefix);
    // A UUID-shaped secret would be far shorter/more structured than a
    // 256-bit base64url string.
    expect(a.raw.length).toBeGreaterThan(40);
  });
});

describe("hashApiKeySecret / verifyApiKeySecret", () => {
  it("verifies a matching key and rejects a non-matching one", () => {
    const generated = generateApiKey();
    expect(verifyApiKeySecret(generated.raw, generated.hash)).toBe(true);
    expect(verifyApiKeySecret("atk_live_wrongsecret", generated.hash)).toBe(false);
  });

  it("never throws on a malformed stored hash", () => {
    expect(verifyApiKeySecret("atk_live_x", "not-a-hex-hash")).toBe(false);
    expect(verifyApiKeySecret("atk_live_x", "")).toBe(false);
  });

  it("is deterministic", () => {
    const raw = "atk_live_fixedvalue";
    expect(hashApiKeySecret(raw)).toBe(hashApiKeySecret(raw));
  });
});

describe("extractApiKeyLookupPrefix", () => {
  it("extracts the lookup prefix from a well-formed key", () => {
    const generated = generateApiKey();
    expect(extractApiKeyLookupPrefix(generated.raw)).toBe(generated.prefix);
  });

  it("returns null for anything not shaped like an AdstrackIO key", () => {
    expect(extractApiKeyLookupPrefix("Bearer xyz")).toBeNull();
    expect(extractApiKeyLookupPrefix("sk_live_stripekey")).toBeNull();
    expect(extractApiKeyLookupPrefix("atk_live_")).toBeNull();
    expect(extractApiKeyLookupPrefix("")).toBeNull();
  });
});
