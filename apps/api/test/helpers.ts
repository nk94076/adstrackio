import { loadEnv } from "@adstrackio/config";
import { buildApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "@adstrackio/auth";
import type { FastifyInstance } from "fastify";

export async function buildTestApp(): Promise<FastifyInstance> {
  const env = loadEnv(process.env);
  return buildApp({ env, logger: false });
}

export function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const headers = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  const sessionHeader = headers.find((h) => h.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error("Session cookie was not set in response");
  }
  return sessionHeader.split(";")[0]!;
}

export interface RegisteredTestAccount {
  cookie: string;
  userId: string;
  email: string;
  organizationId: string | null;
}

let counter = 0;

export async function registerAccount(
  app: FastifyInstance,
  overrides: { email?: string; organizationName?: string } = {},
): Promise<RegisteredTestAccount> {
  counter += 1;
  const email = overrides.email ?? `user${counter}@example.com`;

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: "Str0ngPassword1",
      name: "Test User",
      organizationName: overrides.organizationName,
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`registerAccount failed: ${response.statusCode} ${response.body}`);
  }

  const cookie = extractSessionCookie(response.headers["set-cookie"]);
  const body = response.json();

  return {
    cookie,
    userId: body.user.id,
    email,
    organizationId: body.organizationId ?? null,
  };
}
