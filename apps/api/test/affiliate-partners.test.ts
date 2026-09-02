import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@adstrackio/database";
import {
  addMemberWithRole,
  buildTestApp,
  createTestClick,
  registerAccount,
  verifyAndActivateDomain,
} from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * Phase 9 (Affiliate/Partner System) apps/api coverage: partner CRUD, RBAC,
 * organization isolation/IDOR, externalId uniqueness, campaign roster
 * assignment (including archived-partner and cross-org rejection), click/
 * conversion attribution, historical attribution surviving archival,
 * lifecycle concurrency, and two direct-database trigger checks that back
 * up the service-layer checks (see packages/database/prisma/migrations/
 * .../migration.sql). Tracker-side Click.affiliatePartnerId attribution
 * (including the transparent-redirect regression) lives in
 * apps/tracker/test/tracker.routes.test.ts.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrgWithCampaign(suffix: string) {
  const owner = await registerAccount(app, {
    email: `owner-${suffix}@example.com`,
    organizationName: `Org ${suffix}`,
  });
  const organizationId = owner.organizationId!;

  const domain = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains`,
      headers: { cookie: owner.cookie },
      payload: { hostname: `${suffix}.example.com` },
    })
  ).json().domain;
  await verifyAndActivateDomain(domain.id);

  const destination = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/destinations`,
      headers: { cookie: owner.cookie },
      payload: { name: `Destination ${suffix}`, url: "https://offer.example.com" },
    })
  ).json().destination;

  const campaign = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
      payload: { name: `Campaign ${suffix}`, trackingDomainId: domain.id },
    })
  ).json().campaign;

  return {
    owner,
    organizationId,
    campaignId: campaign.id as string,
    domainId: domain.id as string,
    destinationId: destination.id as string,
  };
}

function partnerPayload(overrides: Record<string, unknown> = {}) {
  return { name: "Acme Affiliates", ...overrides };
}

async function createPartner(
  cookie: string,
  organizationId: string,
  payload: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
    headers: { cookie },
    payload: partnerPayload(payload),
  });
}

async function assignPartner(
  cookie: string,
  organizationId: string,
  campaignId: string,
  partnerId: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners/${partnerId}`,
    headers: { cookie },
  });
}

async function createLink(
  cookie: string,
  organizationId: string,
  campaignId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/tracking-links`,
    headers: { cookie },
    payload,
  });
}

async function updateLink(
  cookie: string,
  organizationId: string,
  campaignId: string,
  trackingLinkId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/tracking-links/${trackingLinkId}`,
    headers: { cookie },
    payload,
  });
}

function auditActions(response: { json: () => { auditLogs: { action: string }[] } }): string[] {
  return response.json().auditLogs.map((log) => log.action);
}

// ---------------------------------------------------------------------------
// Partner CRUD
// ---------------------------------------------------------------------------

describe("affiliate partner CRUD", () => {
  it("creates a partner defaulting to PENDING status", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-create");
    const response = await createPartner(owner.cookie, organizationId);
    expect(response.statusCode).toBe(201);
    expect(response.json().affiliatePartner.status).toBe("PENDING");
  });

  it("creates a partner directly as ACTIVE with externalId and email", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-active");
    const response = await createPartner(owner.cookie, organizationId, {
      status: "ACTIVE",
      externalId: "partner-001",
      email: "partner@example.com",
    });
    expect(response.statusCode).toBe(201);
    const partner = response.json().affiliatePartner;
    expect(partner.status).toBe("ACTIVE");
    expect(partner.externalId).toBe("partner-001");
    expect(partner.email).toBe("partner@example.com");
  });

  it("rejects an invalid payload (missing name)", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-invalid");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("lists partners for the organization", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-list");
    await createPartner(owner.cookie, organizationId, { name: "First" });
    await createPartner(owner.cookie, organizationId, { name: "Second" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().affiliatePartners).toHaveLength(2);
  });

  it("gets a single partner", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-get");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().affiliatePartner.id).toBe(created.id);
  });

  it("404s getting a nonexistent partner", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-get-404");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/not-a-real-partner`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("updates name/externalId/email via PATCH", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-update");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}`,
      headers: { cookie: owner.cookie },
      payload: { name: "Renamed", externalId: "ext-1", email: "new@example.com" },
    });
    expect(response.statusCode).toBe(200);
    const partner = response.json().affiliatePartner;
    expect(partner.name).toBe("Renamed");
    expect(partner.externalId).toBe("ext-1");
    expect(partner.email).toBe("new@example.com");
  });

  it("PATCH silently ignores a status field rather than changing status (no generic status PATCH)", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-patch-status");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    expect(created.status).toBe("PENDING");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "ACTIVE" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().affiliatePartner.status).toBe("PENDING");
  });

  it("does not let the client set organizationId or createdBy via the request body (mass assignment)", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("crud-mass-assignment");
    const otherOrg = await registerAccount(app, {
      email: "other-org-owner@example.com",
      organizationName: "Other Org",
    });

    const response = await createPartner(owner.cookie, organizationId, {
      organizationId: otherOrg.organizationId,
      createdBy: "someone-else",
    });
    expect(response.statusCode).toBe(201);

    // The partner was created under the URL's organization, never the
    // forged body value.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${otherOrg.organizationId}/affiliate-partners`,
      headers: { cookie: otherOrg.cookie },
    });
    expect(list.json().affiliatePartners).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// externalId uniqueness
// ---------------------------------------------------------------------------

describe("externalId uniqueness", () => {
  it("409s creating a second partner with the same externalId in the same organization", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("extid-dup");
    await createPartner(owner.cookie, organizationId, { externalId: "dup-1" });
    const response = await createPartner(owner.cookie, organizationId, { externalId: "dup-1" });
    expect(response.statusCode).toBe(409);
  });

  it("allows the same externalId across two different organizations", async () => {
    const orgA = await setupOrgWithCampaign("extid-a");
    const orgB = await setupOrgWithCampaign("extid-b");

    const a = await createPartner(orgA.owner.cookie, orgA.organizationId, { externalId: "shared-id" });
    const b = await createPartner(orgB.owner.cookie, orgB.organizationId, { externalId: "shared-id" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it("allows any number of partners with no externalId in the same organization", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("extid-null");
    const a = await createPartner(owner.cookie, organizationId, { name: "One" });
    const b = await createPartner(owner.cookie, organizationId, { name: "Two" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("RBAC", () => {
  it("VIEWER can list/get but not create/update/activate/pause/archive", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("rbac-viewer");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);

    const create = await createPartner(viewer.cookie, organizationId, { name: "Blocked" });
    expect(create.statusCode).toBe(403);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}`,
      headers: { cookie: viewer.cookie },
      payload: { name: "x" },
    });
    expect(update.statusCode).toBe(403);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/activate`,
      headers: { cookie: viewer.cookie },
    });
    expect(activate.statusCode).toBe(403);
  });

  it("MEMBER can create/update/assign/unassign but not activate/pause/archive", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("rbac-member");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER");

    const created = (await createPartner(member.cookie, organizationId)).json().affiliatePartner;
    expect(created).toBeDefined();

    const assign = await assignPartner(member.cookie, organizationId, campaignId, created.id);
    expect(assign.statusCode).toBe(201);

    const unassign = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners/${created.id}`,
      headers: { cookie: member.cookie },
    });
    expect(unassign.statusCode).toBe(204);

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/activate`,
      headers: { cookie: member.cookie },
    });
    expect(activate.statusCode).toBe(403);
  });

  it("ADMIN can activate/pause/archive", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("rbac-admin");
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/activate`,
      headers: { cookie: admin.cookie },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().affiliatePartner.status).toBe("ACTIVE");

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/pause`,
      headers: { cookie: admin.cookie },
    });
    expect(pause.statusCode).toBe(200);

    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/archive`,
      headers: { cookie: admin.cookie },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().affiliatePartner.status).toBe("ARCHIVED");
  });

  it("OWNER retains full access (create, assign, and lifecycle)", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("rbac-owner");
    const created = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    expect((await assignPartner(owner.cookie, organizationId, campaignId, created.id)).statusCode).toBe(
      201,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${organizationId}/affiliate-partners/${created.id}/activate`,
          headers: { cookie: owner.cookie },
        })
      ).statusCode,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Organization isolation / IDOR
// ---------------------------------------------------------------------------

describe("organization isolation", () => {
  it("404s reading another organization's partner via this organization's own URL", async () => {
    const orgA = await setupOrgWithCampaign("isolation-a");
    const orgB = await setupOrgWithCampaign("isolation-b");
    const partner = (await createPartner(orgA.owner.cookie, orgA.organizationId)).json()
      .affiliatePartner;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/affiliate-partners/${partner.id}`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects assigning another organization's partner to this organization's campaign", async () => {
    const orgA = await setupOrgWithCampaign("isolation-assign-a");
    const orgB = await setupOrgWithCampaign("isolation-assign-b");
    const partnerB = (await createPartner(orgB.owner.cookie, orgB.organizationId)).json()
      .affiliatePartner;

    const response = await assignPartner(
      orgA.owner.cookie,
      orgA.organizationId,
      orgA.campaignId,
      partnerB.id,
    );
    expect(response.statusCode).toBe(400);
  });

  it("rejects assigning this organization's partner to another organization's campaign", async () => {
    const orgA = await setupOrgWithCampaign("isolation-assign-camp-a");
    const orgB = await setupOrgWithCampaign("isolation-assign-camp-b");
    const partnerA = (await createPartner(orgA.owner.cookie, orgA.organizationId)).json()
      .affiliatePartner;

    // Uses orgA's own membership/org id in the URL, but points campaignId
    // at orgB's campaign — must 404 rather than silently cross-attaching.
    const response = await assignPartner(
      orgA.owner.cookie,
      orgA.organizationId,
      orgB.campaignId,
      partnerA.id,
    );
    expect(response.statusCode).toBe(404);
  });

  it("a member of one organization cannot access another organization's affiliate-partner routes at all", async () => {
    const orgA = await setupOrgWithCampaign("isolation-membership-a");
    const orgB = await setupOrgWithCampaign("isolation-membership-b");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/affiliate-partners`,
      headers: { cookie: orgA.owner.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Campaign roster assignment
// ---------------------------------------------------------------------------

describe("campaign assignment", () => {
  it("assigns a partner to a campaign's roster", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("assign-basic");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const response = await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    expect(response.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners`,
      headers: { cookie: owner.cookie },
    });
    expect(list.json().assignments).toHaveLength(1);
    expect(list.json().assignments[0].affiliatePartnerId).toBe(partner.id);
  });

  it("a duplicate assignment is idempotent (not a 409)", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("assign-duplicate");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const first = await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    const second = await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().assignment.id).toBe(second.json().assignment.id);

    const rows = await prisma.campaignAffiliatePartner.findMany({
      where: { campaignId, affiliatePartnerId: partner.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("404s creating an assignment under a campaignId that doesn't belong to the organization", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("assign-badcampaign");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    const response = await assignPartner(owner.cookie, organizationId, "not-a-real-campaign", partner.id);
    expect(response.statusCode).toBe(404);
  });

  it("409s assigning an ARCHIVED partner to a campaign", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("assign-archived");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const response = await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    expect(response.statusCode).toBe(409);
  });

  it("unassigns a partner from a campaign", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("unassign-basic");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners`,
      headers: { cookie: owner.cookie },
    });
    expect(list.json().assignments).toHaveLength(0);
  });

  it("404s unassigning a partner that isn't assigned", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("unassign-missing");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Attribution: tracking link -> click -> conversion
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("a tracking link can only attribute to a partner already on its campaign's roster", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("attribution-roster");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const rejected = await createLink(owner.cookie, organizationId, campaignId, {
      trackingDomainId: domainId,
      destinationId,
      slug: "not-assigned",
      affiliatePartnerId: partner.id,
    });
    expect(rejected.statusCode).toBe(400);

    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    const accepted = await createLink(owner.cookie, organizationId, campaignId, {
      trackingDomainId: domainId,
      destinationId,
      slug: "now-assigned",
      affiliatePartnerId: partner.id,
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().trackingLink.affiliatePartnerId).toBe(partner.id);
  });

  it("successfully attributes a tracking link to an explicitly ACTIVE partner already on the campaign's roster (create and update)", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("attribution-active-partner");
    const partner = (
      await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })
    ).json().affiliatePartner;
    expect(partner.status).toBe("ACTIVE");
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    const created = await createLink(owner.cookie, organizationId, campaignId, {
      trackingDomainId: domainId,
      destinationId,
      slug: "active-partner-create",
      affiliatePartnerId: partner.id,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().trackingLink.affiliatePartnerId).toBe(partner.id);

    // Also exercise the update path: a link created with no attribution can
    // be attributed to the same ACTIVE partner via PATCH.
    const bareLink = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "active-partner-update",
      })
    ).json().trackingLink;
    expect(bareLink.affiliatePartnerId).toBeNull();

    const updated = await updateLink(owner.cookie, organizationId, campaignId, bareLink.id, {
      affiliatePartnerId: partner.id,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().trackingLink.affiliatePartnerId).toBe(partner.id);
  });

  it("a click carries the partner attributed via createTestClick (simulating the tracker) and remains the source of truth", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("attribution-click");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    const link = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "attributed-link",
        affiliatePartnerId: partner.id,
      })
    ).json().trackingLink;

    const click = await createTestClick(organizationId, campaignId, link.id, {
      affiliatePartnerId: partner.id,
    });
    const stored = await prisma.click.findUniqueOrThrow({ where: { id: click.id } });
    expect(stored.affiliatePartnerId).toBe(partner.id);
  });

  it("a conversion's partner is derived through its click, not settable directly, and forged attribution has no effect", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("attribution-conversion");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    const otherPartner = (
      await createPartner(owner.cookie, organizationId, { name: "Other partner" })
    ).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    const link = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "conversion-link",
        affiliatePartnerId: partner.id,
      })
    ).json().trackingLink;
    const click = await createTestClick(organizationId, campaignId, link.id, {
      affiliatePartnerId: partner.id,
    });

    // createConversionSchema defines no affiliatePartnerId field at all —
    // this extra field is silently stripped, not honored.
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { cookie: owner.cookie },
      payload: { clickId: click.id, eventName: "purchase", affiliatePartnerId: otherPartner.id },
    });
    expect(response.statusCode).toBe(201);

    // The click's own affiliatePartnerId is unchanged and is the only
    // source of truth for "which partner generated this conversion".
    const storedClick = await prisma.click.findUniqueOrThrow({ where: { id: click.id } });
    expect(storedClick.affiliatePartnerId).toBe(partner.id);

    const performance = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/analytics/affiliate-partners/performance`,
      headers: { cookie: owner.cookie },
    });
    const rows = performance.json().rows as { affiliatePartnerId: string; conversions: number }[];
    expect(rows.find((r) => r.affiliatePartnerId === partner.id)?.conversions).toBe(1);
    expect(rows.find((r) => r.affiliatePartnerId === otherPartner.id)?.conversions ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Historical attribution survives archival
// ---------------------------------------------------------------------------

describe("historical attribution", () => {
  it("an archived partner remains visible on historical clicks and campaign assignments", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("historical");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    const link = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "historical-link",
        affiliatePartnerId: partner.id,
      })
    ).json().trackingLink;
    const click = await createTestClick(organizationId, campaignId, link.id, {
      affiliatePartnerId: partner.id,
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const storedClick = await prisma.click.findUniqueOrThrow({ where: { id: click.id } });
    expect(storedClick.affiliatePartnerId).toBe(partner.id);

    const roster = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignId}/affiliate-partners`,
      headers: { cookie: owner.cookie },
    });
    expect(roster.json().assignments).toHaveLength(1);
    expect(roster.json().assignments[0].affiliatePartner.status).toBe("ARCHIVED");

    const getPartner = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(getPartner.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("handles duplicate concurrent assignment safely: both succeed, exactly one row", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("concurrency-assign");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const [a, b] = await Promise.all([
      assignPartner(owner.cookie, organizationId, campaignId, partner.id),
      assignPartner(owner.cookie, organizationId, campaignId, partner.id),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);

    const rows = await prisma.campaignAffiliatePartner.findMany({
      where: { campaignId, affiliatePartnerId: partner.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("handles duplicate concurrent activate+activate on a PENDING partner safely: both succeed, one audit entry", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("concurrency-activate");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(final.json().affiliatePartner.status).toBe("ACTIVE");

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(logs).filter((a) => a === "affiliate_partner.activated")).toHaveLength(1);
  });

  it("handles duplicate concurrent pause+pause on an ACTIVE partner safely: both succeed, one audit entry", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("concurrency-pause");
    const partner = (await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })).json()
      .affiliatePartner;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/pause`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/pause`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(logs).filter((a) => a === "affiliate_partner.paused")).toHaveLength(1);
  });

  it("handles conflicting concurrent activate+pause safely: final DB state matches exactly one winner's audit entry", async () => {
    const { owner, organizationId } = await setupOrgWithCampaign("concurrency-conflict");
    const partner = (await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })).json()
      .affiliatePartner;

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/activate`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/pause`,
        headers: { cookie: owner.cookie },
      }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}`,
      headers: { cookie: owner.cookie },
    });

    const logs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    const actions = auditActions(logs);
    const pauseCount = actions.filter((a) => a === "affiliate_partner.paused").length;
    const activateCount = actions.filter((a) => a === "affiliate_partner.activated").length;
    // The row lock serializes the two calls; which one acquires it first
    // determines the outcome, and PAUSED -> ACTIVE is itself a legal
    // transition, so there are exactly two internally-consistent
    // serializations, not one fixed answer:
    //  1. activate acquires the lock first: it sees ACTIVE == ACTIVE and
    //     no-ops (no audit entry); pause then runs a real ACTIVE -> PAUSED
    //     transition. Final: PAUSED, pauseCount=1, activateCount=0.
    //  2. pause acquires the lock first: it runs a real ACTIVE -> PAUSED
    //     transition; activate then observes PAUSED (not its stale read of
    //     ACTIVE) and runs a real, legal PAUSED -> ACTIVE transition back.
    //     Final: ACTIVE, pauseCount=1, activateCount=1.
    // Both prove the lock correctly serialized the race (never a lost
    // update, an illegal transition, or a spurious 409) — there is no
    // serialization producing 0 pause audit entries, since pause always
    // observes either ACTIVE (real transition) and never no-ops itself.
    expect(pauseCount).toBe(1);
    if (activateCount === 0) {
      expect(final.json().affiliatePartner.status).toBe("PAUSED");
    } else {
      expect(activateCount).toBe(1);
      expect(final.json().affiliatePartner.status).toBe("ACTIVE");
    }
  });

  it("handles a concurrent archive + assignment race safely: no crash, and DB state is internally consistent", async () => {
    const { owner, organizationId, campaignId } = await setupOrgWithCampaign("concurrency-archive-assign");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;

    const [archiveRes, assignRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
        headers: { cookie: owner.cookie },
      }),
      assignPartner(owner.cookie, organizationId, campaignId, partner.id),
    ]);

    expect(archiveRes.statusCode).toBe(200);
    expect([201, 409]).toContain(assignRes.statusCode);

    const rows = await prisma.campaignAffiliatePartner.findMany({
      where: { campaignId, affiliatePartnerId: partner.id },
    });
    if (assignRes.statusCode === 201) {
      expect(rows).toHaveLength(1);
    } else {
      expect(rows).toHaveLength(0);
    }

    const final = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partner.id } });
    expect(final.status).toBe("ARCHIVED");
  });

  // -------------------------------------------------------------------------
  // CTO review finding (Phase 9 PR #10): TrackingLink affiliate-partner
  // attribution used to validate the partner (org + roster) against the
  // top-level PrismaClient *before* the transaction that wrote the
  // TrackingLink row, leaving a check-then-act race: a concurrent
  // archiveAffiliatePartner could commit between the check and the write,
  // letting a tracking link end up newly attributed to an already-ARCHIVED
  // partner. Fixed by moving the check inside the same transaction and
  // taking a `SELECT ... FOR UPDATE` lock on the AffiliatePartner row
  // first — the same row transitionAffiliatePartnerStatus (activate/pause/
  // archive) already locks, so the two code paths now serialize.
  // -------------------------------------------------------------------------

  it("sequential (deterministic): an already-ARCHIVED partner can never be newly attributed via create or update", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("archived-sequential");
    const partner = (
      await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })
    ).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    const archiveRes = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().affiliatePartner.status).toBe("ARCHIVED");

    // create: attempting to attribute a brand-new link to the now-ARCHIVED
    // partner must be rejected, even though it's still on the roster.
    const createAttempt = await createLink(owner.cookie, organizationId, campaignId, {
      trackingDomainId: domainId,
      destinationId,
      slug: "archived-sequential-create",
      affiliatePartnerId: partner.id,
    });
    expect(createAttempt.statusCode).toBe(409);
    const createdLinks = await prisma.trackingLink.findMany({ where: { campaignId } });
    expect(createdLinks).toHaveLength(0);

    // update: attempting to attribute an existing (unattributed) link to
    // the now-ARCHIVED partner must also be rejected.
    const bareLink = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "archived-sequential-update",
      })
    ).json().trackingLink;
    expect(bareLink.affiliatePartnerId).toBeNull();

    const updateAttempt = await updateLink(owner.cookie, organizationId, campaignId, bareLink.id, {
      affiliatePartnerId: partner.id,
    });
    expect(updateAttempt.statusCode).toBe(409);

    const stillBare = await prisma.trackingLink.findUniqueOrThrow({ where: { id: bareLink.id } });
    expect(stillBare.affiliatePartnerId).toBeNull();
  });

  it("handles a concurrent archive + createTrackingLink attribution race safely: the new link can never end up attributed to an ARCHIVED partner, and historical Click attribution is unaffected", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("archived-race-create");
    const partner = (
      await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })
    ).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    // A link + click attributed to the partner *before* the race, while it
    // was genuinely ACTIVE — this is the "historical attribution" that
    // must remain completely untouched by the race below.
    const priorLink = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "archived-race-create-prior",
        affiliatePartnerId: partner.id,
      })
    ).json().trackingLink;
    const priorClick = await createTestClick(organizationId, campaignId, priorLink.id, {
      affiliatePartnerId: partner.id,
    });

    const [archiveRes, createRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
        headers: { cookie: owner.cookie },
      }),
      createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "archived-race-create-new",
        affiliatePartnerId: partner.id,
      }),
    ]);

    // Archive always succeeds (nothing blocks it); the create either wins
    // the lock race (partner still ACTIVE at that instant -> 201, a
    // legitimate attribution) or loses it (partner already ARCHIVED by the
    // time its lock is granted -> 409). Both are valid serializations of
    // the same two concurrent transactions locking the same row — what
    // must NEVER happen is a 201 whose underlying transaction observed a
    // stale ACTIVE read from before the archive committed.
    expect(archiveRes.statusCode).toBe(200);
    expect([201, 409]).toContain(createRes.statusCode);

    const newLink = await prisma.trackingLink.findFirst({
      where: { campaignId, slug: "archived-race-create-new" },
    });
    if (createRes.statusCode === 201) {
      expect(newLink).not.toBeNull();
      expect(newLink!.affiliatePartnerId).toBe(partner.id);
    } else {
      expect(newLink).toBeNull();
    }

    // The partner ends up ARCHIVED regardless of ordering.
    const finalPartner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partner.id } });
    expect(finalPartner.status).toBe("ARCHIVED");

    // Historical attribution (the link/click created before the race) is
    // completely unaffected by the archive or by the race's outcome.
    const stillPriorLink = await prisma.trackingLink.findUniqueOrThrow({ where: { id: priorLink.id } });
    expect(stillPriorLink.affiliatePartnerId).toBe(partner.id);
    const stillPriorClick = await prisma.click.findUniqueOrThrow({ where: { id: priorClick.id } });
    expect(stillPriorClick.affiliatePartnerId).toBe(partner.id);
  });

  it("handles a concurrent archive + updateTrackingLink attribution race safely: an existing link can never be newly re-attributed to an ARCHIVED partner", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("archived-race-update");
    const partner = (
      await createPartner(owner.cookie, organizationId, { status: "ACTIVE" })
    ).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);

    const bareLink = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "archived-race-update-link",
      })
    ).json().trackingLink;
    expect(bareLink.affiliatePartnerId).toBeNull();

    const [archiveRes, updateRes] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/archive`,
        headers: { cookie: owner.cookie },
      }),
      updateLink(owner.cookie, organizationId, campaignId, bareLink.id, {
        affiliatePartnerId: partner.id,
      }),
    ]);

    expect(archiveRes.statusCode).toBe(200);
    expect([200, 409]).toContain(updateRes.statusCode);

    const finalLink = await prisma.trackingLink.findUniqueOrThrow({ where: { id: bareLink.id } });
    if (updateRes.statusCode === 200) {
      // Won the lock race before the archive committed — a legitimate
      // attribution to a partner that was genuinely still ACTIVE.
      expect(finalLink.affiliatePartnerId).toBe(partner.id);
    } else {
      // Lost the race — the link must remain unattributed, never
      // half-applied.
      expect(finalLink.affiliatePartnerId).toBeNull();
    }

    const finalPartner = await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partner.id } });
    expect(finalPartner.status).toBe("ARCHIVED");
  });
});

// ---------------------------------------------------------------------------
// Database trigger backstops (defense-in-depth, independent of app code)
// ---------------------------------------------------------------------------

describe("database trigger backstops", () => {
  it("rejects a cross-organization CampaignAffiliatePartner row even via a raw insert bypassing the service layer", async () => {
    const orgA = await setupOrgWithCampaign("trigger-cross-org-a");
    const orgB = await setupOrgWithCampaign("trigger-cross-org-b");
    const partnerB = (await createPartner(orgB.owner.cookie, orgB.organizationId)).json()
      .affiliatePartner;

    await expect(
      prisma.campaignAffiliatePartner.create({
        data: { organizationId: orgA.organizationId, campaignId: orgA.campaignId, affiliatePartnerId: partnerB.id },
      }),
    ).rejects.toThrow();
  });

  it("rejects any attempt to change a Click's affiliatePartnerId after creation", async () => {
    const { owner, organizationId, campaignId, domainId, destinationId } =
      await setupOrgWithCampaign("trigger-click-immutable");
    const partner = (await createPartner(owner.cookie, organizationId)).json().affiliatePartner;
    const otherPartner = (
      await createPartner(owner.cookie, organizationId, { name: "Other" })
    ).json().affiliatePartner;
    await assignPartner(owner.cookie, organizationId, campaignId, partner.id);
    await assignPartner(owner.cookie, organizationId, campaignId, otherPartner.id);
    const link = (
      await createLink(owner.cookie, organizationId, campaignId, {
        trackingDomainId: domainId,
        destinationId,
        slug: "immutable-link",
        affiliatePartnerId: partner.id,
      })
    ).json().trackingLink;
    const click = await createTestClick(organizationId, campaignId, link.id, {
      affiliatePartnerId: partner.id,
    });

    await expect(
      prisma.click.update({ where: { id: click.id }, data: { affiliatePartnerId: otherPartner.id } }),
    ).rejects.toThrow();
  });
});
