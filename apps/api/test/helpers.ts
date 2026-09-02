import { loadEnv } from "@adstrackio/config";
import { buildApp } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "@adstrackio/auth";
import { prisma } from "@adstrackio/database";
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

/**
 * Test-only shortcut to a VERIFIED+active TrackingDomain, bypassing the
 * real DNS TXT lookup (already exercised end-to-end in
 * domains-lifecycle.test.ts). Phase 6 requires a domain to be
 * VERIFIED+isActive before a Campaign or TrackingLink may reference it
 * (see apps/api/src/modules/shared/org-scoped-refs.ts), so most
 * campaign/tracking-link tests need one of these rather than the freshly
 * created PENDING/inactive domain createDomain-style helpers return. Sets
 * both columns in a single UPDATE to satisfy the
 * tracking_domains_active_requires_verified CHECK constraint.
 */
export async function verifyAndActivateDomain(domainId: string): Promise<void> {
  await prisma.trackingDomain.update({
    where: { id: domainId },
    data: { verificationStatus: "VERIFIED", verifiedAt: new Date(), isActive: true },
  });
}

/** Registers a fresh account and adds it to `organizationId` with `role`. */
export async function addMemberWithRole(
  app: FastifyInstance,
  ownerCookie: string,
  organizationId: string,
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER",
  overrides: { email?: string } = {},
): Promise<RegisteredTestAccount> {
  const account = await registerAccount(app, overrides);
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/members`,
    headers: { cookie: ownerCookie },
    payload: { email: account.email, role },
  });
  if (response.statusCode !== 201) {
    throw new Error(`addMemberWithRole failed: ${response.statusCode} ${response.body}`);
  }
  return account;
}
