import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMemberWithRole,
  buildTestApp,
  registerAccount,
  verifyAndActivateDomain,
} from "./helpers.js";
import { resetDatabase } from "./db-reset.js";

/**
 * Phase 6 (Campaign Manager) coverage: campaign status lifecycle, tracking
 * link lifecycle, the domain/destination assignment constraints Phase 6
 * adds on top of Phase 1-5, the nested campaign -> tracking-link routes,
 * RBAC, and audit events. Basic CRUD (create/list/get/update) and the
 * domain -> destination -> campaign -> tracking-link happy path already
 * live in tracking-foundation.test.ts; cross-organization IDOR already
 * lives in cross-org-isolation.test.ts — this file focuses on what's new.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrgWithDomainAndDestination(suffix: string) {
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
      payload: { name: "Offer", url: `https://offer-${suffix}.example.com` },
    })
  ).json().destination;

  return { owner, organizationId, domain, destination };
}

async function createCampaign(
  cookie: string,
  organizationId: string,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/campaigns`,
    headers: { cookie },
    payload,
  });
  return response;
}

function auditActions(response: { json: () => { auditLogs: { action: string }[] } }): string[] {
  return response.json().auditLogs.map((log) => log.action);
}

// ---------------------------------------------------------------------------
// Campaign status lifecycle
// ---------------------------------------------------------------------------

describe("campaign lifecycle", () => {
  it("defaults a new campaign to DRAFT and can create one directly as ACTIVE", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-default");

    const draft = await createCampaign(owner.cookie, organizationId, { name: "Draft Campaign" });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().campaign.status).toBe("DRAFT");

    const active = await createCampaign(owner.cookie, organizationId, {
      name: "Active Campaign",
      status: "ACTIVE",
    });
    expect(active.statusCode).toBe(201);
    expect(active.json().campaign.status).toBe("ACTIVE");
  });

  it.each(["PAUSED", "ARCHIVED"])(
    "rejects creating a campaign directly in %s status",
    async (status) => {
      const { owner, organizationId } = await setupOrgWithDomainAndDestination(
        `lc-create-${status.toLowerCase()}`,
      );

      const response = await createCampaign(owner.cookie, organizationId, {
        name: "Fabricated History",
        status,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    },
  );

  it("walks the full legal lifecycle: DRAFT -> ACTIVE -> PAUSED -> ACTIVE -> ARCHIVED, each recorded in the audit log", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-full");
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Lifecycle" })).json()
      .campaign;

    const activate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().campaign.status).toBe("ACTIVE");

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/pause`,
      headers: { cookie: owner.cookie },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().campaign.status).toBe("PAUSED");

    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().campaign.status).toBe("ACTIVE");

    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().campaign.status).toBe("ARCHIVED");

    const auditLogs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(auditLogs)).toEqual(
      expect.arrayContaining([
        "campaign.created",
        "campaign.activated",
        "campaign.paused",
        "campaign.archived",
      ]),
    );
    // activate was called twice (DRAFT->ACTIVE, then PAUSED->ACTIVE) —
    // both must be recorded, not deduplicated away.
    expect(auditActions(auditLogs).filter((a) => a === "campaign.activated")).toHaveLength(2);
  });

  it("archived campaigns can never be reactivated", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-archived");
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Dead" })).json()
      .campaign;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const reactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(reactivate.statusCode).toBe(409);
    expect(reactivate.json().error.code).toBe("CONFLICT");

    const pauseAttempt = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/pause`,
      headers: { cookie: owner.cookie },
    });
    expect(pauseAttempt.statusCode).toBe(409);
  });

  it("rejects DRAFT -> PAUSED (a campaign must be activated before it can be paused)", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-draft-pause");
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "New" })).json()
      .campaign;

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/pause`,
      headers: { cookie: owner.cookie },
    });
    expect(pause.statusCode).toBe(409);
    expect(pause.json().error.code).toBe("CONFLICT");
  });

  it("activating an already-ACTIVE campaign is an idempotent no-op, not an error", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-idempotent");
    const campaign = (
      await createCampaign(owner.cookie, organizationId, { name: "Already Active", status: "ACTIVE" })
    ).json().campaign;

    const activateAgain = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(activateAgain.statusCode).toBe(200);
    expect(activateAgain.json().campaign.status).toBe("ACTIVE");
  });

  it("cannot force a status change through the generic PATCH endpoint (mass assignment / status manipulation)", async () => {
    const { owner, organizationId } = await setupOrgWithDomainAndDestination("lc-mass-assign");
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Guarded" })).json()
      .campaign;
    expect(campaign.status).toBe("DRAFT");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "ARCHIVED", name: "Still Guarded" },
    });
    expect(patch.statusCode).toBe(200);
    // name legitimately changed; status silently ignored (not rejected —
    // the field simply isn't part of the schema, same as any unknown key).
    expect(patch.json().campaign.name).toBe("Still Guarded");
    expect(patch.json().campaign.status).toBe("DRAFT");
  });
});

// ---------------------------------------------------------------------------
// Domain / destination assignment constraints
// ---------------------------------------------------------------------------

describe("campaign domain constraints", () => {
  it("rejects an unverified domain", async () => {
    const owner = await registerAccount(app, {
      email: "unverified@example.com",
      organizationName: "Unverified Org",
    });
    const organizationId = owner.organizationId!;
    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "unverified.example.com" },
      })
    ).json().domain;

    const response = await createCampaign(owner.cookie, organizationId, {
      name: "Premature",
      trackingDomainId: domain.id,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a verified-but-inactive domain", async () => {
    const owner = await registerAccount(app, {
      email: "inactive-domain@example.com",
      organizationName: "Inactive Domain Org",
    });
    const organizationId = owner.organizationId!;
    const domain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "inactive.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(domain.id);
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/domains/${domain.id}/deactivate`,
      headers: { cookie: owner.cookie },
    });

    const response = await createCampaign(owner.cookie, organizationId, {
      name: "Dead Domain",
      trackingDomainId: domain.id,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects changing trackingDomainId on an ACTIVE campaign", async () => {
    const { owner, organizationId, domain } = await setupOrgWithDomainAndDestination("dc-active");
    const secondDomain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "second-dc-active.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(secondDomain.id);

    const campaign = (
      await createCampaign(owner.cookie, organizationId, {
        name: "Live",
        status: "ACTIVE",
        trackingDomainId: domain.id,
      })
    ).json().campaign;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: secondDomain.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
  });

  it("allows changing trackingDomainId once the campaign is paused", async () => {
    const { owner, organizationId, domain } = await setupOrgWithDomainAndDestination("dc-paused");
    const secondDomain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "second-dc-paused.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(secondDomain.id);

    const campaign = (
      await createCampaign(owner.cookie, organizationId, {
        name: "Live",
        status: "ACTIVE",
        trackingDomainId: domain.id,
      })
    ).json().campaign;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/pause`,
      headers: { cookie: owner.cookie },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: secondDomain.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().campaign.trackingDomainId).toBe(secondDomain.id);
  });

  it("allows changing destinationId on an ACTIVE campaign (not gated the way trackingDomainId is)", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "dc-dest-active",
    );
    const secondDestination = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/destinations`,
        headers: { cookie: owner.cookie },
        payload: { name: "Second Offer", url: "https://second-offer.example.com" },
      })
    ).json().destination;

    const campaign = (
      await createCampaign(owner.cookie, organizationId, {
        name: "Live",
        status: "ACTIVE",
        trackingDomainId: domain.id,
        destinationId: destination.id,
      })
    ).json().campaign;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: owner.cookie },
      payload: { destinationId: secondDestination.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().campaign.destinationId).toBe(secondDestination.id);
  });
});

// ---------------------------------------------------------------------------
// Tracking link nested routes + lifecycle
// ---------------------------------------------------------------------------

describe("tracking link management (nested under campaign)", () => {
  it("creates, lists, gets, and updates a tracking link via the nested campaign routes", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-nested",
    );
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Nested" })).json()
      .campaign;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "spring" },
    });
    expect(created.statusCode).toBe(201);
    const link = created.json().trackingLink;
    expect(link.campaignId).toBe(campaign.id);
    expect(link.status).toBe("ACTIVE");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().trackingLinks).toHaveLength(1);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().trackingLink.id).toBe(link.id);

    const secondDestination = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/destinations`,
        headers: { cookie: owner.cookie },
        payload: { name: "New Offer", url: "https://new-offer.example.com" },
      })
    ).json().destination;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}`,
      headers: { cookie: owner.cookie },
      payload: { destinationId: secondDestination.id },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().trackingLink.destinationId).toBe(secondDestination.id);
  });

  it("404s when the link exists but under a different campaign (wrong campaign/link relationship)", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-wrong-campaign",
    );
    const campaignA = (await createCampaign(owner.cookie, organizationId, { name: "A" })).json()
      .campaign;
    const campaignB = (await createCampaign(owner.cookie, organizationId, { name: "B" })).json()
      .campaign;

    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaignA.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "belongs-to-a" },
      })
    ).json().trackingLink;

    const getViaWrongCampaign = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignB.id}/tracking-links/${link.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(getViaWrongCampaign.statusCode).toBe(404);

    const patchViaWrongCampaign = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaignB.id}/tracking-links/${link.id}`,
      headers: { cookie: owner.cookie },
      payload: { metadata: { hijacked: true } },
    });
    expect(patchViaWrongCampaign.statusCode).toBe(404);
  });

  it("walks the full link lifecycle: ACTIVE -> PAUSED -> ACTIVE -> ARCHIVED, and archived cannot be reactivated", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-lifecycle",
    );
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Lifecycle" })).json()
      .campaign;
    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "lifecycle" },
      })
    ).json().trackingLink;

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/pause`,
      headers: { cookie: owner.cookie },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().trackingLink.status).toBe("PAUSED");

    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().trackingLink.status).toBe("ACTIVE");

    const archive = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/archive`,
      headers: { cookie: owner.cookie },
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().trackingLink.status).toBe("ARCHIVED");

    const reactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(reactivate.statusCode).toBe(409);

    const auditLogs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(auditLogs)).toEqual(
      expect.arrayContaining([
        "tracking_link.created",
        "tracking_link.paused",
        "tracking_link.activated",
        "tracking_link.archived",
      ]),
    );
  });

  it("cannot force a status change through the generic PATCH endpoint", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-mass-assign",
    );
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Guarded" })).json()
      .campaign;
    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "guarded" },
      })
    ).json().trackingLink;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}`,
      headers: { cookie: owner.cookie },
      payload: { status: "ARCHIVED" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().trackingLink.status).toBe("ACTIVE");
  });

  it("rejects creating a tracking link under an archived campaign", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-archived-campaign",
    );
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Retired" })).json()
      .campaign;
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "too-late" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
  });

  it("rejects reactivating a paused link once its campaign has been archived", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-archived-campaign-reactivate",
    );
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Going Away" })).json()
      .campaign;
    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "soon-archived" },
      })
    ).json().trackingLink;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/pause`,
      headers: { cookie: owner.cookie },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/archive`,
      headers: { cookie: owner.cookie },
    });

    const reactivate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/activate`,
      headers: { cookie: owner.cookie },
    });
    expect(reactivate.statusCode).toBe(409);
  });

  it("scopes slug uniqueness to the tracking domain, not the campaign — the same slug is fine on a different domain", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "tl-slug-scope",
    );
    const secondDomain = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/domains`,
        headers: { cookie: owner.cookie },
        payload: { hostname: "second-tl-slug-scope.example.com" },
      })
    ).json().domain;
    await verifyAndActivateDomain(secondDomain.id);

    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Slug Scope" })).json()
      .campaign;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "shared-slug" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: {
        trackingDomainId: secondDomain.id,
        destinationId: destination.id,
        slug: "shared-slug",
      },
    });
    expect(second.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "shared-slug" },
    });
    expect(duplicate.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("campaign manager RBAC", () => {
  it("VIEWER can read campaigns and tracking links but cannot create, update, or run lifecycle actions", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "rbac-viewer",
    );
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER", {
      email: "viewer-rbac@example.com",
    });
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Viewer Target" })).json()
      .campaign;
    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "viewer-link" },
      })
    ).json().trackingLink;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);

    const create = await createCampaign(viewer.cookie, organizationId, { name: "Should Fail" });
    expect(create.statusCode).toBe(403);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: viewer.cookie },
      payload: { name: "Hijacked" },
    });
    expect(update.statusCode).toBe(403);

    for (const action of ["activate", "pause", "archive"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/${action}`,
        headers: { cookie: viewer.cookie },
      });
      expect(response.statusCode, `campaign ${action}`).toBe(403);
    }

    for (const action of ["activate", "pause", "archive"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/${action}`,
        headers: { cookie: viewer.cookie },
      });
      expect(response.statusCode, `tracking link ${action}`).toBe(403);
    }
  });

  it("MEMBER can create/update campaigns and tracking links but cannot run lifecycle actions", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "rbac-member",
    );
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER", {
      email: "member-rbac@example.com",
    });

    const create = await createCampaign(member.cookie, organizationId, { name: "Member Created" });
    expect(create.statusCode).toBe(201);
    const campaign = create.json().campaign;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}`,
      headers: { cookie: member.cookie },
      payload: { name: "Member Updated" },
    });
    expect(update.statusCode).toBe(200);

    const linkCreate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: member.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "member-link" },
    });
    expect(linkCreate.statusCode).toBe(201);
    const link = linkCreate.json().trackingLink;

    for (const action of ["activate", "pause", "archive"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/${action}`,
        headers: { cookie: member.cookie },
      });
      expect(response.statusCode, `campaign ${action}`).toBe(403);
    }

    const linkPause = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/pause`,
      headers: { cookie: member.cookie },
    });
    expect(linkPause.statusCode).toBe(403);
  });

  it("ADMIN can run lifecycle actions on campaigns and tracking links", async () => {
    const { owner, organizationId, domain, destination } = await setupOrgWithDomainAndDestination(
      "rbac-admin",
    );
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN", {
      email: "admin-rbac@example.com",
    });
    const campaign = (await createCampaign(owner.cookie, organizationId, { name: "Admin Target" })).json()
      .campaign;
    const link = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
        headers: { cookie: owner.cookie },
        payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "admin-link" },
      })
    ).json().trackingLink;

    const activateCampaignResponse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/activate`,
      headers: { cookie: admin.cookie },
    });
    expect(activateCampaignResponse.statusCode).toBe(200);

    const pauseLinkResponse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links/${link.id}/pause`,
      headers: { cookie: admin.cookie },
    });
    expect(pauseLinkResponse.statusCode).toBe(200);
  });

  it("rejects unauthenticated requests to every campaign and tracking-link lifecycle endpoint", async () => {
    const { organizationId } = await setupOrgWithDomainAndDestination("rbac-unauth");

    const requests: Array<["GET" | "POST" | "PATCH", string]> = [
      ["GET", `/api/v1/organizations/${organizationId}/campaigns`],
      ["POST", `/api/v1/organizations/${organizationId}/campaigns`],
      ["POST", `/api/v1/organizations/${organizationId}/campaigns/nonexistent/activate`],
      ["POST", `/api/v1/organizations/${organizationId}/campaigns/nonexistent/pause`],
      ["POST", `/api/v1/organizations/${organizationId}/campaigns/nonexistent/archive`],
      ["GET", `/api/v1/organizations/${organizationId}/campaigns/nonexistent/tracking-links`],
      ["POST", `/api/v1/organizations/${organizationId}/campaigns/nonexistent/tracking-links`],
    ];

    for (const [method, url] of requests) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
