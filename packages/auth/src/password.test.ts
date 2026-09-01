import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("hashes a password to an argon2id hash distinct from the input", async () => {
    const hash = await hashPassword("Str0ngPassword!");
    expect(hash).not.toBe("Str0ngPassword!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("verifies a matching password", async () => {
    const hash = await hashPassword("Str0ngPassword!");
    await expect(verifyPassword(hash, "Str0ngPassword!")).resolves.toBe(true);
  });

  it("rejects a non-matching password", async () => {
    const hash = await hashPassword("Str0ngPassword!");
    await expect(verifyPassword(hash, "WrongPassword!")).resolves.toBe(false);
  });

  it("rejects a malformed hash instead of throwing", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const [hashA, hashB] = await Promise.all([
      hashPassword("Str0ngPassword!"),
      hashPassword("Str0ngPassword!"),
    ]);
    expect(hashA).not.toBe(hashB);
  });
});
