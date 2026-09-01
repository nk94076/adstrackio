import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE_NAME = "adstrackio_session";

/** Session tokens are short-lived by design; the client silently re-issues
 * one on each authenticated request pattern used by apps/api's auth plugin. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  /** User id (subject). */
  userId: string;
  /** Currently active organization, if any has been selected. */
  activeOrganizationId?: string;
}

export interface CreateSessionTokenOptions {
  secret: string;
  payload: SessionPayload;
  ttlSeconds?: number;
}

/**
 * Creates a signed, stateless session token (JWT, HS256). AdstrackIO does
 * not persist server-side sessions in Phase 1 — see docs/architecture/security.md
 * for the tradeoffs (short TTL, no server-side revocation list yet).
 */
export async function createSessionToken(options: CreateSessionTokenOptions): Promise<string> {
  const secretKey = new TextEncoder().encode(options.secret);
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS;

  return new SignJWT({ activeOrganizationId: options.payload.activeOrganizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(options.payload.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(secretKey);
}

export class InvalidSessionError extends Error {
  constructor(cause?: unknown) {
    super("Session token is invalid or expired");
    this.name = "InvalidSessionError";
    this.cause = cause;
  }
}

/**
 * Verifies and decodes a session token. Throws InvalidSessionError for any
 * malformed, expired, or tampered token so callers can uniformly respond
 * with 401 without leaking why verification failed.
 */
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload> {
  const secretKey = new TextEncoder().encode(secret);
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (typeof payload.sub !== "string") {
      throw new Error("Missing subject claim");
    }
    return {
      userId: payload.sub,
      activeOrganizationId:
        typeof payload.activeOrganizationId === "string" ? payload.activeOrganizationId : undefined,
    };
  } catch (error) {
    throw new InvalidSessionError(error);
  }
}
