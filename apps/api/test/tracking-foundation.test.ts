import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, registerAccount, verifyAndActivateDomain } from "./helpers.js";
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
    organizationName: "Tracking Org",
  });
  return { cookie: account.cookie, organizationId: account.organizationId! };
}

describe("tracking domain foundation", () => {
  it("creates a domain in PENDING verification status", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie },
      payload: { hostname: "track.example.com" },
    });

    expect(response.statusCode).toBe(201);
    const domain = response.json().domain;
    expect(domain.verificationStatus).toBe("PENDING");
    expect(domain.sslStatus).toBe("NOT_CONFIGURED");
  });

  it("rejects an invalid hostname", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie },
      payload: { hostname: "not a hostname" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a duplicate hostname across organizations", async () => {
    const first = await setupOrg();
    const second = await setupOrg();

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${first.organizationId}/domains`,
      headers: { cookie: first.cookie },
      payload: { hostname: "shared.example.com" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${second.organizationId}/domains`,
      headers: { cookie: second.cookie },
      payload: { hostname: "shared.example.com" },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe("destination foundation", () => {
  it("normalizes a valid https destination URL", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/destinations`,
      headers: { cookie },
      payload: { name: "Offer Page", url: "https://Offers.example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().destination.url).toBe("https://offers.example.com/");
  });

  it("rejects a javascript: destination URL as a validation error, not a server error", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/destinations`,
      headers: { cookie },
      payload: { name: "Malicious", url: "javascript:alert(1)" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("campaign and tracking link foundation", () => {
  it("normalizes a valid safePageUrl and rejects a dangerous scheme", async () => {
    const { cookie, organizationId } = await setupOrg();

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: { name: "Safe Page Campaign", safePageUrl: "https://Safe.example.com" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().campaign.safePageUrl).toBe("https://safe.example.com/");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: { name: "Malicious Safe Page", safePageUrl: "javascript:alert(1)" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("defaults suspiciousTrafficPolicy/unknownTrafficPolicy to TARGET when not specified (Phase 5)", async () => {
    const { cookie, organizationId } = await setupOrg();

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: { name: "Default Policy Campaign" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().campaign.suspiciousTrafficPolicy).toBe("TARGET");
    expect(created.json().campaign.unknownTrafficPolicy).toBe("TARGET");
  });

  it("accepts an explicit bot-traffic policy at creation and can update it afterward (Phase 5)", async () => {
    const { cookie, organizationId } = await setupOrg();

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: {
        name: "Explicit Policy Campaign",
        suspiciousTrafficPolicy: "SAFE_PAGE",
        unknownTrafficPolicy: "BLOCK",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().campaign.suspiciousTrafficPolicy).toBe("SAFE_PAGE");
    expect(created.json().campaign.unknownTrafficPolicy).toBe("BLOCK");

    const campaignId = created.json().campaign.id;
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}`,
      headers: { cookie },
      payload: { suspiciousTrafficPolicy: "TARGET" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().campaign.suspiciousTrafficPolicy).toBe("TARGET");
    // Untouched field is preserved, not reset to a default.
    expect(updated.json().campaign.unknownTrafficPolicy).toBe("BLOCK");
  });

  it("rejects an invalid bot-traffic policy value (Phase 5)", async () => {
    const { cookie, organizationId } = await setupOrg();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: { name: "Invalid Policy Campaign", suspiciousTrafficPolicy: "REDIRECT_TO_MOON" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("supports the full chain: domain -> destination -> campaign -> tracking link", async () => {
    const { cookie, organizationId } = await setupOrg();

    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie },
        payload: { hostname: "go.example.com" },
      })
    ).json().domain;

    const destination = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/destinations`,
        headers: { cookie },
        payload: { name: "Landing Page", url: "https://landing.example.com" },
      })
    ).json().destination;

    // Phase 6: a campaign/tracking link can only reference a domain that
    // has completed verification and is active.
    await verifyAndActivateDomain(domain.id);

    const campaignResponse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie },
      payload: {
        name: "Q1 Launch",
        trackingDomainId: domain.id,
        destinationId: destination.id,
      },
    });
    expect(campaignResponse.statusCode).toBe(201);
    const campaign = campaignResponse.json().campaign;
    expect(campaign.status).toBe("DRAFT");

    const trackingLinkResponse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/tracking-links`,
      headers: { cookie },
      payload: {
        campaignId: campaign.id,
        trackingDomainId: domain.id,
        destinationId: destination.id,
        slug: "spring-sale",
      },
    });

    expect(trackingLinkResponse.statusCode).toBe(201);
    expect(trackingLinkResponse.json().trackingLink.status).toBe("ACTIVE");

    const duplicateSlug = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/tracking-links`,
      headers: { cookie },
      payload: {
        campaignId: campaign.id,
        trackingDomainId: domain.id,
        destinationId: destination.id,
        slug: "spring-sale",
      },
    });
    expect(duplicateSlug.statusCode).toBe(409);
  });

  it("rejects a tracking link whose destination belongs to a different organization", async () => {
    const org1 = await setupOrg();
    const org2 = await setupOrg();

    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org1.organizationId}/domains`,
        headers: { cookie: org1.cookie },
        payload: { hostname: "org1.example.com" },
      })
    ).json().domain;

    const foreignDestination = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org2.organizationId}/destinations`,
        headers: { cookie: org2.cookie },
        payload: { name: "Foreign", url: "https://foreign.example.com" },
      })
    ).json().destination;

    const campaign = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org1.organizationId}/campaigns`,
        headers: { cookie: org1.cookie },
        payload: { name: "Cross-org test" },
      })
    ).json().campaign;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${org1.organizationId}/tracking-links`,
      headers: { cookie: org1.cookie },
      payload: {
        campaignId: campaign.id,
        trackingDomainId: domain.id,
        destinationId: foreignDestination.id,
        slug: "cross-org",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
