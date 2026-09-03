import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Symmetric encryption-at-rest for secrets this codebase must be able to
 * RETRIEVE later in plaintext — unlike ApiKey.keyHash or User.passwordHash
 * (one-way, never decrypted), a WebhookEndpoint's signing secret must be
 * read back by the delivery worker to compute each outgoing HMAC
 * signature (see docs/api/webhooks.md#secret-storage). AES-256-GCM is used
 * rather than a weaker/reversible-but-homegrown scheme; the key is derived
 * from AUTH_SECRET so no new secret-management surface is introduced.
 *
 * This protects a raw database dump/backup from revealing webhook
 * secrets. It does NOT protect against a compromised API process itself
 * (which holds AUTH_SECRET and could decrypt anything it stores) — that
 * limitation is inherent to any design where the server must reproduce a
 * symmetric signature, and is the same boundary every HMAC-webhook system
 * (Stripe, GitHub, ...) accepts. See docs/api/webhooks.md#secret-storage.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function deriveKey(masterSecret: string): Buffer {
  // Domain-separated from any other derivation of AUTH_SECRET (e.g.
  // session JWT signing, cookie signing) via a fixed context string, so
  // this key can never collide with or be confused for one used
  // elsewhere.
  return createHash("sha256").update(masterSecret).update("adstrackio:webhook-secret-box:v1").digest();
}

/** Encrypts `plaintext`; returns a single base64 string encoding
 * iv + authTag + ciphertext, safe to store in one text column. */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export class SecretBoxError extends Error {
  constructor(message = "Failed to decrypt stored secret") {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** Decrypts a value produced by `encryptSecret`. Throws SecretBoxError on
 * any tampering, corruption, or key mismatch — never returns a partial or
 * garbage plaintext. */
export function decryptSecret(encoded: string, masterSecret: string): string {
  const key = deriveKey(masterSecret);
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length < IV_LENGTH + 16) {
    throw new SecretBoxError();
  }
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = buffer.subarray(IV_LENGTH + 16);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new SecretBoxError(error instanceof Error ? error.message : undefined);
  }
}

/** Generates a new random webhook signing secret (raw, unencrypted) —
 * shown to the caller once at creation/rotation time, mirroring
 * ApiKey/generateApiKey's one-time-reveal contract even though (unlike an
 * API key) this value IS retained server-side (encrypted) for signing. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
