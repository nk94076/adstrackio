import type { FastifyInstance } from "fastify";
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
});
