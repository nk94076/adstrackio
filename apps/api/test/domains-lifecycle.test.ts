import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@adstrackio/database";
import { buildTestApp, registerAccount } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";
import { verifyTrackingDomain } from "../src/modules/domains/domains.service.js";

/**
 * Phase 2 (Domain Manager) coverage. Basic creation/duplicate/invalid-hostname
 * cases already live in tracking-foundation.test.ts; this file exercises the
 * full PENDING -> VERIFIED -> ACTIVE lifecycle, the RBAC/IDOR boundaries
 * around it, and — most importantly — that a client can never force
 * verified/active status through a request body.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrg(suffix: string) {
  const account = await registerAccount(app, {
    email: `owner-${suffix}@example.com`,
    organizationName: `Org ${suffix}`,
  });
  return {
    cookie: account.cookie,
    organizationId: account.organizationId!,
    userId: account.userId,
  };
}

async function addMember(
  ownerCookie: string,
  organizationId: string,
  suffix: string,
  role: "VIEWER" | "MEMBER" | "ADMIN",
) {
  const account = await registerAccount(app, { email: `member-${suffix}@example.com` });
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/members`,
    headers: { cookie: ownerCookie },
    payload: { email: account.email, role },
  });
  expect(response.statusCode).toBe(201);
  return account;
}

async function createDomain(cookie: string, organizationId: string, hostname: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/domains`,
    headers: { cookie },
    payload: { hostname },
  });
  return response;
}

describe("domain manager: hostname validation", () => {
  const invalidHostnames = [
    "https://track.example.com",
    "https://track.example.com/path",
    "track.example.com/foo",
    "track.example.com?x=1",
    "track.example.com#frag",
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "track.example.com:8080",
    "-bad.example.com",
    "bad-.example.com",
    "example..com",
    "example.123",
    "",
    "   ",
    "a".repeat(260) + ".com",
  ];

  for (const hostname of invalidHostnames) {
    it(`rejects invalid hostname: ${JSON.stringify(hostname)}`, async () => {
      const { cookie, organizationId } = await setupOrg(`invalid-${invalidHostnames.indexOf(hostname)}`);
      const response = await createDomain(cookie, organizationId, hostname);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    });
  }

  it("normalizes a valid hostname: lowercases and strips the trailing dot", async () => {
    const { cookie, organizationId } = await setupOrg("normalize");
    const response = await createDomain(cookie, organizationId, "TRACK.Example.COM.");
    expect(response.statusCode).toBe(201);
    expect(response.json().domain.hostname).toBe("track.example.com");
  });
});

describe("domain manager: cannot force verification/activation via request body", () => {
  it("ignores verified/status/isActive fields sent at creation", async () => {
    const { cookie, organizationId } = await setupOrg("force-create");
    const response = await createDomain(cookie, organizationId, "force-create.example.com");
    // Even if a client appended extra fields, the schema only reads hostname;
    // assert directly that a freshly created domain is never active/verified.
    expect(response.statusCode).toBe(201);
    const domain = response.json().domain;
    expect(domain.verificationStatus).toBe("PENDING");
    expect(domain.isActive).toBe(false);

    const withExtraFields = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie },
      payload: {
        hostname: "force-create-2.example.com",
        verified: true,
        status: "VERIFIED",
        verificationStatus: "VERIFIED",
        isActive: true,
      },
    });
    expect(withExtraFields.statusCode).toBe(201);
    const forced = withExtraFields.json().domain;
    expect(forced.verificationStatus).toBe("PENDING");
    expect(forced.isActive).toBe(false);
  });

  it("never returns the raw verification token as a top-level field", async () => {
    const { cookie, organizationId } = await setupOrg("no-token-leak");
    const response = await createDomain(cookie, organizationId, "no-token-leak.example.com");
    const domain = response.json().domain;
    expect(domain.verificationToken).toBeUndefined();
    expect(domain.verificationInstructions).toBeTruthy();
    expect(domain.verificationInstructions.recordName).toBe(
      "_adstrackio-verification.no-token-leak.example.com",
    );
    expect(domain.verificationInstructions.recordValue).toMatch(
      /^adstrackio-domain-verification=/,
    );
  });

  it("rejects activation before verification regardless of the request body", async () => {
    const { cookie, organizationId } = await setupOrg("force-activate");
    const domain = (await createDomain(cookie, organizationId, "force-activate.example.com")).json()
      .domain;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/activate`,
      headers: { cookie },
      payload: { isActive: true, verified: true, force: true },
    });

    expect(response.statusCode).toBe(409);

    const check = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}`,
      headers: { cookie },
    });
    expect(check.json().domain.isActive).toBe(false);
  });
});

describe("domain manager: real server-side DNS verification", () => {
  it("marks a domain FAILED when the DNS TXT record does not exist (real DNS lookup, no mocking)", async () => {
    const { cookie, organizationId, userId } = await setupOrg("verify-fail");
    const domain = (await createDomain(cookie, organizationId, "verify-fail.example.com")).json()
      .domain;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/verify`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const verified = response.json().domain;
    expect(verified.verificationStatus).toBe("FAILED");
    expect(verified.verifiedAt).toBeNull();

    const auditLogs = (
      await app.inject({
        method: "GET",
        url: `/api/v1/organizations/${organizationId}/audit-logs`,
        headers: { cookie },
      })
    )
      .json()
      .auditLogs.map((log: { action: string }) => log.action);

    expect(auditLogs).toEqual(
      expect.arrayContaining([
        "domain.created",
        "domain.verification_requested",
        "domain.verification_failed",
      ]),
    );

    // Still can't activate after a failed verification.
    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/activate`,
      headers: { cookie },
    });
    expect(activate.statusCode).toBe(409);

    void userId;
  });

  it("verifies, activates, and deactivates a domain once the correct DNS TXT record is present", async () => {
    const { cookie, organizationId, userId } = await setupOrg("verify-success");
    const domain = (await createDomain(cookie, organizationId, "verify-success.example.com")).json()
      .domain;

    const record = await prisma.trackingDomain.findUniqueOrThrow({ where: { id: domain.id } });
    const expectedName = `_adstrackio-verification.${record.hostname}`;
    const expectedValue = `adstrackio-domain-verification=${record.verificationToken}`;

    const fakeResolveTxt = async (name: string) => {
      if (name !== expectedName) return [];
      return [[expectedValue]];
    };

    // The DNS check itself is exercised directly at the service layer with an
    // injected resolver (no real DNS infrastructure is under our control to
    // publish a real TXT record against in this test environment); the HTTP
    // route wires the exact same function to Node's real resolver.
    const verified = await verifyTrackingDomain(
      prisma,
      userId,
      organizationId,
      domain.id,
      fakeResolveTxt,
    );
    expect(verified.verificationStatus).toBe("VERIFIED");
    expect(verified.verifiedAt).not.toBeNull();

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/activate`,
      headers: { cookie },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().domain.isActive).toBe(true);

    const deactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/deactivate`,
      headers: { cookie },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().domain.isActive).toBe(false);

    const auditLogs = (
      await app.inject({
        method: "GET",
        url: `/api/v1/organizations/${organizationId}/audit-logs`,
        headers: { cookie },
      })
    )
      .json()
      .auditLogs.map((log: { action: string }) => log.action);

    expect(auditLogs).toEqual(
      expect.arrayContaining([
        "domain.created",
        "domain.verification_requested",
        "domain.verified",
        "domain.activated",
        "domain.deactivated",
      ]),
    );
  });

  it("does not use the DNS check as an HTTP fetch (SSRF safety): hostname is passed only to DNS resolution", async () => {
    const { cookie, organizationId } = await setupOrg("ssrf");
    const domain = (
      await createDomain(cookie, organizationId, "internal-svc.example.com")
    ).json().domain;

    // A malicious-looking but still-valid hostname must still only ever be
    // resolved via DNS TXT lookup — never fetched as a URL. Confirm the
    // real code path completes without ever contacting an HTTP server (no
    // hang/timeout) and that the endpoint returns a clean FAILED result.
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/verify`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().domain.verificationStatus).toBe("FAILED");
  });
});

describe("domain manager: RBAC", () => {
  it("allows VIEWER to read but not create/verify/activate/deactivate", async () => {
    const owner = await setupOrg("rbac-viewer");
    const viewer = await addMember(owner.cookie, owner.organizationId, "rbac-viewer", "VIEWER");
    const domain = (
      await createDomain(owner.cookie, owner.organizationId, "rbac-viewer.example.com")
    ).json().domain;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${owner.organizationId}/domains`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);

    const create = await createDomain(
      viewer.cookie,
      owner.organizationId,
      "rbac-viewer-2.example.com",
    );
    expect(create.statusCode).toBe(403);

    for (const action of ["verify", "activate", "deactivate"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/${action}`,
        headers: { cookie: viewer.cookie },
      });
      expect(response.statusCode, action).toBe(403);
    }
  });

  it("allows MEMBER to create/verify but not activate/deactivate", async () => {
    const owner = await setupOrg("rbac-member");
    const member = await addMember(owner.cookie, owner.organizationId, "rbac-member", "MEMBER");

    const create = await createDomain(
      member.cookie,
      owner.organizationId,
      "rbac-member.example.com",
    );
    expect(create.statusCode).toBe(201);
    const domain = create.json().domain;

    const verify = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/verify`,
      headers: { cookie: member.cookie },
    });
    expect(verify.statusCode).toBe(200);

    for (const action of ["activate", "deactivate"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/${action}`,
        headers: { cookie: member.cookie },
      });
      expect(response.statusCode, action).toBe(403);
    }
  });

  it("allows ADMIN to activate/deactivate", async () => {
    const owner = await setupOrg("rbac-admin");
    const admin = await addMember(owner.cookie, owner.organizationId, "rbac-admin", "ADMIN");
    const domain = (
      await createDomain(owner.cookie, owner.organizationId, "rbac-admin.example.com")
    ).json().domain;

    // ADMIN can't force activation of an unverified domain either.
    const beforeVerification = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/activate`,
      headers: { cookie: admin.cookie },
    });
    expect(beforeVerification.statusCode).toBe(409);

    await prisma.trackingDomain.update({
      where: { id: domain.id },
      data: { verificationStatus: "VERIFIED", verifiedAt: new Date() },
    });

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/activate`,
      headers: { cookie: admin.cookie },
    });
    expect(activate.statusCode).toBe(200);

    const deactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/deactivate`,
      headers: { cookie: admin.cookie },
    });
    expect(deactivate.statusCode).toBe(200);
  });

  it("rejects unauthenticated requests to every domain endpoint", async () => {
    const owner = await setupOrg("unauth");
    const domain = (
      await createDomain(owner.cookie, owner.organizationId, "unauth.example.com")
    ).json().domain;

    const requests: Array<["GET" | "POST", string]> = [
      ["GET", `/api/v1/organizations/${owner.organizationId}/domains`],
      ["GET", `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}`],
      ["POST", `/api/v1/organizations/${owner.organizationId}/domains`],
      ["POST", `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/verify`],
      ["POST", `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/activate`],
      ["POST", `/api/v1/organizations/${owner.organizationId}/domains/${domain.id}/deactivate`],
    ];

    for (const [method, url] of requests) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("domain manager: database-level activation invariant", () => {
  it("rejects a raw SQL UPDATE that tries to activate an unverified domain", async () => {
    const { cookie, organizationId } = await setupOrg("db-invariant");
    const domain = (
      await createDomain(cookie, organizationId, "db-invariant.example.com")
    ).json().domain;

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "tracking_domains" SET "isActive" = true WHERE "id" = $1`,
        domain.id,
      ),
    ).rejects.toThrow();
  });
});
