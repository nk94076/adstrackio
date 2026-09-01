import argon2 from "argon2";

/**
 * Hashes a plaintext password with argon2id (the OWASP-recommended variant,
 * resistant to both GPU cracking and side-channel attacks).
 */
export async function hashPassword(plainTextPassword: string): Promise<string> {
  return argon2.hash(plainTextPassword, { type: argon2.argon2id });
}

/**
 * Verifies a plaintext password against a stored argon2 hash. Never throws
 * on a mismatched password — returns false instead — but propagates
 * unexpected errors (e.g. a corrupt hash) to the caller.
 */
export async function verifyPassword(hash: string, plainTextPassword: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainTextPassword);
  } catch {
    return false;
  }
}
