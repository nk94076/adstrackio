export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(body: ApiErrorBody, statusCode: number) {
    super(body.error.message);
    this.name = "ApiClientError";
    this.code = body.error.code;
    this.statusCode = statusCode;
    this.details = body.error.details;
  }
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Thin fetch wrapper for apps/api. Runs client-side only: the API sits on
 * a separate origin/port and issues an httpOnly session cookie, so the
 * browser (not the Next.js server) must be the one attaching it via
 * `credentials: "include"`. Server components in this app therefore avoid
 * calling the API directly — see docs/architecture/overview.md for the
 * tradeoff this accepts in Phase 1.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      // Fastify's JSON body parser rejects an empty body sent with this
      // header (e.g. POST /auth/logout, POST .../activate), so only send
      // it when there's actually a body to parse.
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiClientError(
      body ?? { error: { code: "UNKNOWN_ERROR", message: response.statusText } },
      response.status,
    );
  }

  return body as T;
}
