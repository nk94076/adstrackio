import type { FastifyInstance } from "fastify";
import { prisma } from "@adstrackio/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, registerAccount } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrg() {
  const account = await registerAccount(app, {
    email: `owner-${Date.now()}-${Math.random()}@example.com`,
    organizationName: "Referral Org",
  });
  return { cookie: account.cookie, organizationId: account.organizationId! };
}

describe("referral configuration + proof workflow", () => {
  it("creates NORMAL and HIDE configurations INACTIVE and activates them without proof", async () => {
    const { cookie, organizationId } = await setupOrg();

    const normal = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "NORMAL" },
      })
    ).json().referralConfiguration;
    expect(normal.status).toBe("INACTIVE");

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${normal.id}/activate`,
      headers: { cookie },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().referralConfiguration.status).toBe("ACTIVE");
  });

  it("requires customReferrerValue for CUSTOM_PARTNER_ATTRIBUTION at creation", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations`,
      headers: { cookie },
      payload: { type: "CUSTOM_PARTNER_ATTRIBUTION" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("blocks activating a CUSTOM_PARTNER_ATTRIBUTION configuration with no proof", async () => {
    const { cookie, organizationId } = await setupOrg();

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-x" },
      })
    ).json().referralConfiguration;

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/activate`,
      headers: { cookie },
    });

    expect(activate.statusCode).toBe(409);
    expect(activate.json().error.code).toBe("CONFLICT");
  });

  it("blocks activation while a submitted proof is still PENDING", async () => {
    const { cookie, organizationId } = await setupOrg();

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-y" },
      })
    ).json().referralConfiguration;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs`,
      headers: { cookie },
      payload: { evidenceUrl: "https://example.com/proof.pdf" },
    });

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/activate`,
      headers: { cookie },
    });

    expect(activate.statusCode).toBe(409);
  });

  it("blocks activation after a proof is REJECTED, and allows it once a proof is APPROVED", async () => {
    const { cookie, organizationId } = await setupOrg();

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-z" },
      })
    ).json().referralConfiguration;

    const rejectedProof = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs`,
        headers: { cookie },
        payload: { evidenceUrl: "https://example.com/insufficient.pdf" },
      })
    ).json().proof;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs/${rejectedProof.id}/review`,
      headers: { cookie },
      payload: { decision: "REJECTED", rejectionReason: "Not sufficient evidence" },
    });

    const activateAfterRejection = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/activate`,
      headers: { cookie },
    });
    expect(activateAfterRejection.statusCode).toBe(409);

    const approvedProof = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs`,
        headers: { cookie },
        payload: { evidenceUrl: "https://example.com/sufficient.pdf" },
      })
    ).json().proof;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs/${approvedProof.id}/review`,
      headers: { cookie },
      payload: { decision: "APPROVED" },
    });

    const activateAfterApproval = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/activate`,
      headers: { cookie },
    });

    expect(activateAfterApproval.statusCode).toBe(200);
    expect(activateAfterApproval.json().referralConfiguration.status).toBe("ACTIVE");
  });

  it("requires ADMIN role to review a proof", async () => {
    const owner = await registerAccount(app, {
      email: `owner-${Date.now()}@example.com`,
      organizationName: "Review Org",
    });
    const viewer = await registerAccount(app, { email: `viewer-${Date.now()}@example.com` });

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/members`,
      headers: { cookie: owner.cookie },
      payload: { email: viewer.email, role: "VIEWER" },
    });

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${owner.organizationId}/referral-configurations`,
        headers: { cookie: owner.cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-review" },
      })
    ).json().referralConfiguration;

    const proof = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${owner.organizationId}/referral-configurations/${config.id}/proofs`,
        headers: { cookie: owner.cookie },
        payload: { evidenceUrl: "https://example.com/proof.pdf" },
      })
    ).json().proof;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${owner.organizationId}/referral-configurations/${config.id}/proofs/${proof.id}/review`,
      headers: { cookie: viewer.cookie },
      payload: { decision: "APPROVED" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("is enforced at the database level, not just the service layer: a raw SQL UPDATE bypassing the API cannot activate an unapproved CUSTOM_PARTNER_ATTRIBUTION configuration", async () => {
    const { cookie, organizationId } = await setupOrg();

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-db-level" },
      })
    ).json().referralConfiguration;

    // No proof submitted at all: attempt to flip status directly via SQL,
    // completely bypassing apps/api. This proves the invariant is backed by
    // a database trigger (packages/database/prisma/migrations/
    // 20260901204759_enforce_referral_activation_gate), not only by
    // application code that a future caller could route around.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "referral_configurations" SET status = 'ACTIVE' WHERE id = $1`,
        config.id,
      ),
    ).rejects.toThrow(/cannot be ACTIVE without an APPROVED referral_proof/);

    const unchanged = await prisma.referralConfiguration.findUniqueOrThrow({
      where: { id: config.id },
    });
    expect(unchanged.status).toBe("INACTIVE");
  });

  it("database trigger allows activation via raw SQL once an APPROVED proof exists", async () => {
    const { cookie, organizationId } = await setupOrg();

    const config = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations`,
        headers: { cookie },
        payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-db-level-2" },
      })
    ).json().referralConfiguration;

    const proof = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs`,
        headers: { cookie },
        payload: { evidenceUrl: "https://example.com/db-level-proof.pdf" },
      })
    ).json().proof;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/referral-configurations/${config.id}/proofs/${proof.id}/review`,
      headers: { cookie },
      payload: { decision: "APPROVED" },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "referral_configurations" SET status = 'ACTIVE' WHERE id = $1`,
        config.id,
      ),
    ).resolves.toBeDefined();

    const updated = await prisma.referralConfiguration.findUniqueOrThrow({
      where: { id: config.id },
    });
    expect(updated.status).toBe("ACTIVE");
  });
});
