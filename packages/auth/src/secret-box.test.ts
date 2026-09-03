import { describe, expect, it } from "vitest";
import { SecretBoxError, decryptSecret, encryptSecret, generateWebhookSecret } from "./secret-box.js";

const MASTER_SECRET = "test-master-secret-at-least-32-characters-long";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const encrypted = encryptSecret("whsec_hello_world", MASTER_SECRET);
    expect(encrypted).not.toContain("whsec_hello_world");
    expect(decryptSecret(encrypted, MASTER_SECRET)).toBe("whsec_hello_world");
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    const a = encryptSecret("same-value", MASTER_SECRET);
    const b = encryptSecret("same-value", MASTER_SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, MASTER_SECRET)).toBe("same-value");
    expect(decryptSecret(b, MASTER_SECRET)).toBe("same-value");
  });

  it("fails to decrypt with the wrong master secret", () => {
    const encrypted = encryptSecret("whsec_x", MASTER_SECRET);
    expect(() => decryptSecret(encrypted, "a-completely-different-master-secret-value")).toThrow(
      SecretBoxError,
    );
  });

  it("fails to decrypt tampered ciphertext (authentication tag check)", () => {
    const encrypted = encryptSecret("whsec_x", MASTER_SECRET);
    const buffer = Buffer.from(encrypted, "base64");
    buffer[buffer.length - 1] = buffer[buffer.length - 1]! ^ 0xff;
    expect(() => decryptSecret(buffer.toString("base64"), MASTER_SECRET)).toThrow(SecretBoxError);
  });

  it("rejects a garbage/too-short input rather than throwing an unrelated error", () => {
    expect(() => decryptSecret("not-valid-base64-or-too-short", MASTER_SECRET)).toThrow(SecretBoxError);
  });
});

describe("generateWebhookSecret", () => {
  it("produces a unique, prefixed, high-entropy secret each time", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_/);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });
});
