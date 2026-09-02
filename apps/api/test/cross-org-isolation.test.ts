import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, registerAccount } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * A user from Organization A must never be able to read or modify
 * Organization B's resources by changing an ID in the request — the
 * requirement this file exists to pin down. It exercises every
 * organization-scoped resource type against a real second organization's
 * data, over real HTTP requests (not by calling service functions
 * directly), so it also proves the route-level authorization guard
 * actually runs for each of these endpoints.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupTwoOrgs() {
  const ownerA = await registerAccount(app, {
    email: "org-a-owner@example.com",
    organizationName: "Org A",
  });
  const ownerB = await registerAccount(app, {
    email: "org-b-owner@example.com",
    organizationName: "Org B",
  });

  const orgA = ownerA.organizationId!;
  const orgB = ownerB.organizationId!;

  const domainA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/domains`,
      headers: { cookie: ownerA.cookie },
      payload: { hostname: "a.example.com" },
    })
  ).json().domain;

  const destinationA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/destinations`,
      headers: { cookie: ownerA.cookie },
      payload: { name: "A Destination", url: "https://a-dest.example.com" },
    })
  ).json().destination;

  const campaignA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/campaigns`,
      headers: { cookie: ownerA.cookie },
      payload: {
        name: "A Campaign",
        trackingDomainId: domainA.id,
        destinationId: destinationA.id,
      },
    })
  ).json().campaign;

  const trackingLinkA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/tracking-links`,
      headers: { cookie: ownerA.cookie },
      payload: {
        campaignId: campaignA.id,
        trackingDomainId: domainA.id,
        destinationId: destinationA.id,
        slug: "a-slug",
      },
    })
  ).json().trackingLink;

  const referralConfigA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/referral-configurations`,
      headers: { cookie: ownerA.cookie },
      payload: { type: "CUSTOM_PARTNER_ATTRIBUTION", customReferrerValue: "partner-a" },
    })
  ).json().referralConfiguration;

  const proofA = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/referral-configurations/${referralConfigA.id}/proofs`,
      headers: { cookie: ownerA.cookie },
      payload: { evidenceUrl: "https://example.com/a-proof.pdf" },
    })
  ).json().proof;

  return {
    ownerA,
    ownerB,
    orgA,
    orgB,
    domainA,
    destinationA,
    campaignA,
    trackingLinkA,
    referralConfigA,
    proofA,
  };
}

describe("cross-organization isolation (IDOR)", () => {
  it("blocks an Org B member from reading Org A's organization, members, and audit logs", async () => {
    const { ownerB, orgA } = await setupTwoOrgs();

    for (const url of [
      `/api/v1/organizations/${orgA}`,
      `/api/v1/organizations/${orgA}/members`,
      `/api/v1/organizations/${orgA}/audit-logs`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: ownerB.cookie },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it("blocks an Org B member from reading or modifying Org A's tracking domain", async () => {
    const { ownerB, orgA, domainA } = await setupTwoOrgs();

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA}/domains/${domainA.id}`,
      headers: { cookie: ownerB.cookie },
    });
    expect(read.statusCode).toBe(403);

    for (const action of ["verify", "activate", "deactivate"]) {
      const write = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgA}/domains/${domainA.id}/${action}`,
        headers: { cookie: ownerB.cookie },
      });
      expect(write.statusCode, action).toBe(403);
    }
  });

  it("blocks an Org B member from reading or tampering with Org A's destination URL", async () => {
    const { ownerB, orgA, destinationA } = await setupTwoOrgs();

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA}/destinations/${destinationA.id}`,
      headers: { cookie: ownerB.cookie },
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA}/destinations/${destinationA.id}`,
      headers: { cookie: ownerB.cookie },
      payload: { url: "https://attacker-controlled.example.com" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("blocks an Org B member from reading or modifying Org A's campaign", async () => {
    const { ownerB, orgA, campaignA } = await setupTwoOrgs();

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA}/campaigns/${campaignA.id}`,
      headers: { cookie: ownerB.cookie },
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA}/campaigns/${campaignA.id}`,
      headers: { cookie: ownerB.cookie },
      payload: { status: "ARCHIVED" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("blocks an Org B member from reading or modifying Org A's tracking link", async () => {
    const { ownerB, orgA, trackingLinkA } = await setupTwoOrgs();

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA}/tracking-links/${trackingLinkA.id}`,
      headers: { cookie: ownerB.cookie },
    });
    expect(read.statusCode).toBe(403);

    const write = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA}/tracking-links/${trackingLinkA.id}`,
      headers: { cookie: ownerB.cookie },
      payload: { status: "ARCHIVED" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("blocks an Org B member from reading, activating, or submitting/reviewing proofs on Org A's referral configuration", async () => {
    const { ownerB, orgA, referralConfigA, proofA } = await setupTwoOrgs();

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA}/referral-configurations/${referralConfigA.id}`,
      headers: { cookie: ownerB.cookie },
    });
    expect(read.statusCode).toBe(403);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/referral-configurations/${referralConfigA.id}/activate`,
      headers: { cookie: ownerB.cookie },
    });
    expect(activate.statusCode).toBe(403);

    const submitProof = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/referral-configurations/${referralConfigA.id}/proofs`,
      headers: { cookie: ownerB.cookie },
      payload: { evidenceUrl: "https://evil.example.com/fake.pdf" },
    });
    expect(submitProof.statusCode).toBe(403);

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/referral-configurations/${referralConfigA.id}/proofs/${proofA.id}/review`,
      headers: { cookie: ownerB.cookie },
      payload: { decision: "APPROVED" },
    });
    expect(review.statusCode).toBe(403);
  });

  it("blocks an Org B member from adding themselves as a member of Org A", async () => {
    const { ownerB, orgA } = await setupTwoOrgs();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/members`,
      headers: { cookie: ownerB.cookie },
      payload: { email: "org-b-owner@example.com", role: "OWNER" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a campaign in Org A that references a tracking domain or destination owned by Org B", async () => {
    const { ownerA, orgA, orgB, ownerB } = await setupTwoOrgs();

    const domainB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/domains`,
        headers: { cookie: ownerB.cookie },
        payload: { hostname: "b.example.com" },
      })
    ).json().domain;

    const destinationB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/destinations`,
        headers: { cookie: ownerB.cookie },
        payload: { name: "B Destination", url: "https://b-dest.example.com" },
      })
    ).json().destination;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/campaigns`,
      headers: { cookie: ownerA.cookie },
      payload: {
        name: "Cross-org campaign",
        trackingDomainId: domainB.id,
        destinationId: destinationB.id,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a tracking link in Org A that references a destination owned by Org B", async () => {
    const { ownerA, orgA, orgB, ownerB, campaignA, domainA } = await setupTwoOrgs();

    const destinationB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/destinations`,
        headers: { cookie: ownerB.cookie },
        payload: { name: "B Destination 2", url: "https://b-dest2.example.com" },
      })
    ).json().destination;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA}/tracking-links`,
      headers: { cookie: ownerA.cookie },
      payload: {
        campaignId: campaignA.id,
        trackingDomainId: domainA.id,
        destinationId: destinationB.id,
        slug: "cross-org-slug",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects re-pointing Org A's own campaign at Org B's tracking domain/destination via PATCH", async () => {
    const { ownerA, orgA, orgB, ownerB, campaignA } = await setupTwoOrgs();

    const domainB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/domains`,
        headers: { cookie: ownerB.cookie },
        payload: { hostname: "b-patch.example.com" },
      })
    ).json().domain;

    const destinationB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/destinations`,
        headers: { cookie: ownerB.cookie },
        payload: { name: "B Destination Patch", url: "https://b-dest-patch.example.com" },
      })
    ).json().destination;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA}/campaigns/${campaignA.id}`,
      headers: { cookie: ownerA.cookie },
      payload: { trackingDomainId: domainB.id, destinationId: destinationB.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects re-pointing Org A's own tracking link at Org B's destination via PATCH", async () => {
    const { ownerA, orgA, orgB, ownerB, trackingLinkA } = await setupTwoOrgs();

    const destinationB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgB}/destinations`,
        headers: { cookie: ownerB.cookie },
        payload: { name: "B Destination Patch 2", url: "https://b-dest-patch2.example.com" },
      })
    ).json().destination;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${orgA}/tracking-links/${trackingLinkA.id}`,
      headers: { cookie: ownerA.cookie },
      payload: { destinationId: destinationB.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("never returns Org B's resources when Org B legitimately lists its own (sanity check for false negatives)", async () => {
    const { ownerB, orgB } = await setupTwoOrgs();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB}/domains`,
      headers: { cookie: ownerB.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().domains).toEqual([]);
  });
});
