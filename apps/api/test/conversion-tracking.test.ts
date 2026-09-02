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
 * Phase 7 (Conversion Tracking) coverage: click-derived attribution
 * (never client-supplied), deduplication via externalConversionId, the
 * PENDING/APPROVED/REJECTED/REVERSED lifecycle, RBAC, IDOR, mass
 * assignment, and conversion analytics. Cross-org IDOR for
 * campaigns/tracking-links/domains/destinations already lives in
 * cross-org-isolation.test.ts; this file focuses on what's new.
 */

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrgWithClick(suffix: string, botClassification: "HUMAN" | "BOT" = "HUMAN") {
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

  const campaign = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
      payload: { name: "Campaign", trackingDomainId: domain.id, destinationId: destination.id },
    })
  ).json().campaign;

  const trackingLink = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links`,
      headers: { cookie: owner.cookie },
      payload: { trackingDomainId: domain.id, destinationId: destination.id, slug: "s1" },
    })
  ).json().trackingLink;

  const click = await createTestClick(organizationId, campaign.id, trackingLink.id, {
    botClassification,
  });

  return { owner, organizationId, domain, destination, campaign, trackingLink, click };
}

async function createConversion(
  cookie: string,
  organizationId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/conversions`,
    headers: { cookie },
    payload,
  });
}

function auditActions(response: { json: () => { auditLogs: { action: string }[] } }): string[] {
  return response.json().auditLogs.map((log) => log.action);
}

// ---------------------------------------------------------------------------
// Creation + click attribution
// ---------------------------------------------------------------------------

describe("conversion creation", () => {
  it("creates a conversion and derives campaignId/trackingLinkId/organizationId from the click", async () => {
    const { owner, organizationId, campaign, trackingLink, click } = await setupOrgWithClick("create");

    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 49.99,
      currency: "usd",
    });

    expect(response.statusCode).toBe(201);
    const conversion = response.json().conversion;
    expect(conversion.clickId).toBe(click.id);
    expect(conversion.campaignId).toBe(campaign.id);
    expect(conversion.trackingLinkId).toBe(trackingLink.id);
    expect(conversion.organizationId).toBe(organizationId);
    expect(conversion.status).toBe("PENDING");
    expect(conversion.currency).toBe("USD"); // normalized uppercase
    expect(conversion.value).toBe("49.99");
  });

  it("404s on a missing clickId", async () => {
    const { owner, organizationId } = await setupOrgWithClick("missing-click");

    const response = await createConversion(owner.cookie, organizationId, {
      clickId: "00000000-0000-4000-8000-000000000000",
      eventName: "purchase",
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s (not 400/403) on a clickId belonging to another organization — uniform not-found, no existence leak", async () => {
    const orgA = await setupOrgWithClick("cross-org-a");
    const orgB = await setupOrgWithClick("cross-org-b");

    const response = await createConversion(orgA.owner.cookie, orgA.organizationId, {
      clickId: orgB.click.id,
      eventName: "purchase",
    });
    expect(response.statusCode).toBe(404);
  });

  it("ignores a client-supplied campaignId/trackingLinkId/organizationId override attempt (attribution always comes from the click)", async () => {
    const { owner, organizationId, campaign, trackingLink, click } =
      await setupOrgWithClick("no-override");
    const otherOrg = await setupOrgWithClick("no-override-attacker");

    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      // Attacker-controlled attribution fields — must be silently ignored,
      // not merely rejected, since they aren't even part of the schema.
      campaignId: otherOrg.campaign.id,
      trackingLinkId: otherOrg.trackingLink.id,
      organizationId: otherOrg.organizationId,
    });

    expect(response.statusCode).toBe(201);
    const conversion = response.json().conversion;
    expect(conversion.campaignId).toBe(campaign.id);
    expect(conversion.trackingLinkId).toBe(trackingLink.id);
    expect(conversion.organizationId).toBe(organizationId);
  });

  it("rejects a negative value", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("negative-value");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: -10,
      currency: "USD",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-numeric value", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("nan-value");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: "not-a-number",
      currency: "USD",
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires value and currency to be supplied together", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("value-currency-pair");

    const valueOnly = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 10,
    });
    expect(valueOnly.statusCode).toBe(400);

    const currencyOnly = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      currency: "USD",
    });
    expect(currencyOnly.statusCode).toBe(400);
  });

  it("rejects an invalid currency code", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("bad-currency");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      value: 10,
      currency: "US",
    });
    expect(response.statusCode).toBe(400);
  });

  it("allows a conversion event with no monetary value at all (e.g. a signup)", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("no-value-event");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "signup",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().conversion.value).toBeNull();
  });

  it("rejects an occurredAt far in the future", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("future-date");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      occurredAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts an occurredAt within ordinary clock-skew tolerance", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("small-skew");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      occurredAt: new Date(Date.now() + 30 * 1000).toISOString(),
    });
    expect(response.statusCode).toBe(201);
  });

  it("rejects an oversized metadata payload", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("big-metadata");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      metadata: { blob: "x".repeat(20_000) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a too-deeply-nested metadata payload", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("deep-metadata");
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) {
      nested = { child: nested };
    }
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      metadata: nested,
    });
    expect(response.statusCode).toBe(400);
  });

  it("accepts a reasonably small/shallow metadata payload", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("ok-metadata");
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      metadata: { orderId: "abc123", items: 3 },
    });
    expect(response.statusCode).toBe(201);
  });

  it("writes a conversion.created audit log entry", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("audit-created");
    await createConversion(owner.cookie, organizationId, { clickId: click.id, eventName: "purchase" });

    const auditLogs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(auditLogs)).toContain("conversion.created");
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("conversion deduplication", () => {
  it("rejects a repeated externalConversionId within the same organization", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("dedup");

    const first = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      externalConversionId: "order-123",
    });
    expect(first.statusCode).toBe(201);

    const second = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      externalConversionId: "order-123",
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("CONFLICT");

    const count = await prisma.conversion.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it("handles concurrent duplicate submissions safely: exactly one succeeds", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("dedup-concurrent");

    const payload = { clickId: click.id, eventName: "purchase", externalConversionId: "race-1" };
    const [a, b] = await Promise.all([
      createConversion(owner.cookie, organizationId, payload),
      createConversion(owner.cookie, organizationId, payload),
    ]);

    const statusCodes = [a.statusCode, b.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);

    const count = await prisma.conversion.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it("allows different externalConversionIds to coexist", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("dedup-different");

    const a = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      externalConversionId: "order-a",
    });
    const b = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
      externalConversionId: "order-b",
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it("allows multiple conversions with no externalConversionId at all (no forced uniqueness)", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("dedup-no-external-id");

    const a = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
    });
    const b = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });

  it("allows the same externalConversionId to be reused across different organizations", async () => {
    const orgA = await setupOrgWithClick("dedup-scope-a");
    const orgB = await setupOrgWithClick("dedup-scope-b");

    const a = await createConversion(orgA.owner.cookie, orgA.organizationId, {
      clickId: orgA.click.id,
      eventName: "purchase",
      externalConversionId: "shared-id",
    });
    const b = await createConversion(orgB.owner.cookie, orgB.organizationId, {
      clickId: orgB.click.id,
      eventName: "purchase",
      externalConversionId: "shared-id",
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("conversion lifecycle", () => {
  async function createPending(owner: { cookie: string }, organizationId: string, click: { id: string }) {
    const response = await createConversion(owner.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
    });
    return response.json().conversion;
  }

  it("walks PENDING -> APPROVED -> REVERSED, each recorded in the audit log", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("lifecycle-approve-reverse");
    const conversion = await createPending(owner, organizationId, click);

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().conversion.status).toBe("APPROVED");

    const reverse = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reverse`,
      headers: { cookie: owner.cookie },
    });
    expect(reverse.statusCode).toBe(200);
    expect(reverse.json().conversion.status).toBe("REVERSED");

    const auditLogs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    expect(auditActions(auditLogs)).toEqual(
      expect.arrayContaining(["conversion.created", "conversion.approved", "conversion.reversed"]),
    );
  });

  it("walks PENDING -> REJECTED", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("lifecycle-reject");
    const conversion = await createPending(owner, organizationId, click);

    const reject = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reject`,
      headers: { cookie: owner.cookie },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().conversion.status).toBe("REJECTED");
  });

  it.each(["approve", "reverse"])(
    "rejects %s on an already-REJECTED conversion (terminal state)",
    async (illegalAction) => {
      const { owner, organizationId, click } = await setupOrgWithClick(
        `lifecycle-rejected-terminal-${illegalAction}`,
      );
      const conversion = await createPending(owner, organizationId, click);

      const reject = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reject`,
        headers: { cookie: owner.cookie },
      });
      expect(reject.json().conversion.status).toBe("REJECTED");

      const illegal = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/${illegalAction}`,
        headers: { cookie: owner.cookie },
      });
      expect(illegal.statusCode).toBe(409);
      expect(illegal.json().error.code).toBe("CONFLICT");
    },
  );

  it.each(["approve", "reject"])(
    "rejects %s on an already-REVERSED conversion (terminal state)",
    async (illegalAction) => {
      const { owner, organizationId, click } = await setupOrgWithClick(
        `lifecycle-reversed-terminal-${illegalAction}`,
      );
      const conversion = await createPending(owner, organizationId, click);

      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
        headers: { cookie: owner.cookie },
      });
      const reverse = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reverse`,
        headers: { cookie: owner.cookie },
      });
      expect(reverse.json().conversion.status).toBe("REVERSED");

      const illegal = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/${illegalAction}`,
        headers: { cookie: owner.cookie },
      });
      expect(illegal.statusCode).toBe(409);
      expect(illegal.json().error.code).toBe("CONFLICT");
    },
  );

  it("rejects PENDING -> REVERSED directly (must be approved first)", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("lifecycle-pending-reverse");
    const conversion = await createPending(owner, organizationId, click);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reverse`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it("is idempotent: approving an already-APPROVED conversion succeeds without duplicating the audit log", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("lifecycle-idempotent");
    const conversion = await createPending(owner, organizationId, click);

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
      headers: { cookie: owner.cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().conversion.status).toBe("APPROVED");

    const auditLogs = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/audit-logs`,
      headers: { cookie: owner.cookie },
    });
    const approvedCount = auditActions(auditLogs).filter((a) => a === "conversion.approved").length;
    expect(approvedCount).toBe(1);
  });

  it("handles concurrent status changes safely: exactly one of approve/reject wins from PENDING", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("lifecycle-concurrent");
    const conversion = await createPending(owner, organizationId, click);

    const [approve, reject] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
        headers: { cookie: owner.cookie },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/reject`,
        headers: { cookie: owner.cookie },
      }),
    ]);

    const statusCodes = [approve.statusCode, reject.statusCode].sort();
    // Both are legal from PENDING individually, but only one can win the
    // race against the conditional updateMany guarding on the status it
    // read — the loser sees status already changed and gets a 409.
    expect(statusCodes).toEqual([200, 409]);

    const final = await prisma.conversion.findUniqueOrThrow({ where: { id: conversion.id } });
    expect(["APPROVED", "REJECTED"]).toContain(final.status);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("conversion RBAC", () => {
  it("VIEWER can list/get but not create or run status actions", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("rbac-viewer");
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER", {
      email: "viewer-conv@example.com",
    });
    const conversion = (
      await createConversion(owner.cookie, organizationId, { clickId: click.id, eventName: "purchase" })
    ).json().conversion;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}`,
      headers: { cookie: viewer.cookie },
    });
    expect(get.statusCode).toBe(200);

    const create = await createConversion(viewer.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
    });
    expect(create.statusCode).toBe(403);

    for (const action of ["approve", "reject", "reverse"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/${action}`,
        headers: { cookie: viewer.cookie },
      });
      expect(response.statusCode, action).toBe(403);
    }
  });

  it("MEMBER can create conversions but not run status actions", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("rbac-member");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER", {
      email: "member-conv@example.com",
    });

    const create = await createConversion(member.cookie, organizationId, {
      clickId: click.id,
      eventName: "purchase",
    });
    expect(create.statusCode).toBe(201);
    const conversion = create.json().conversion;

    for (const action of ["approve", "reject", "reverse"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/${action}`,
        headers: { cookie: member.cookie },
      });
      expect(response.statusCode, action).toBe(403);
    }
  });

  it("ADMIN can run status actions", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("rbac-admin");
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN", {
      email: "admin-conv@example.com",
    });
    const conversion = (
      await createConversion(owner.cookie, organizationId, { clickId: click.id, eventName: "purchase" })
    ).json().conversion;

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(approve.statusCode).toBe(200);
  });

  it("rejects unauthenticated requests to every conversion endpoint", async () => {
    const { organizationId } = await setupOrgWithClick("rbac-unauth");

    const requests: Array<["GET" | "POST", string]> = [
      ["GET", `/api/v1/organizations/${organizationId}/conversions`],
      ["POST", `/api/v1/organizations/${organizationId}/conversions`],
      ["GET", `/api/v1/organizations/${organizationId}/conversions/nonexistent`],
      ["POST", `/api/v1/organizations/${organizationId}/conversions/nonexistent/approve`],
      ["POST", `/api/v1/organizations/${organizationId}/conversions/nonexistent/reject`],
      ["POST", `/api/v1/organizations/${organizationId}/conversions/nonexistent/reverse`],
    ];

    for (const [method, url] of requests) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Security / IDOR
// ---------------------------------------------------------------------------

describe("conversion security", () => {
  it("blocks an Org B member from reading or modifying Org A's conversion", async () => {
    const orgA = await setupOrgWithClick("idor-a");
    const orgB = await setupOrgWithClick("idor-b");
    const conversion = (
      await createConversion(orgA.owner.cookie, orgA.organizationId, {
        clickId: orgA.click.id,
        eventName: "purchase",
      })
    ).json().conversion;

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA.organizationId}/conversions/${conversion.id}`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(read.statusCode).toBe(403);

    for (const action of ["approve", "reject", "reverse"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${orgA.organizationId}/conversions/${conversion.id}/${action}`,
        headers: { cookie: orgB.owner.cookie },
      });
      expect(response.statusCode, action).toBe(403);
    }
  });

  it("never returns Org B's conversions when Org B legitimately lists its own", async () => {
    const orgA = await setupOrgWithClick("idor-list-a");
    const orgB = await setupOrgWithClick("idor-list-b");
    await createConversion(orgA.owner.cookie, orgA.organizationId, {
      clickId: orgA.click.id,
      eventName: "purchase",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/conversions`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().conversions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("conversion analytics", () => {
  it("reports status breakdown, approved value, and conversion rate (approved / human clicks)", async () => {
    const { owner, organizationId, campaign, trackingLink } = await setupOrgWithClick("analytics-1");

    // 3 more HUMAN clicks (4 total including the one from setup) and 1 BOT
    // click, which must never count toward the human-click denominator.
    for (let i = 0; i < 3; i++) {
      await createTestClick(organizationId, campaign.id, trackingLink.id, { botClassification: "HUMAN" });
    }
    const botClick = await createTestClick(organizationId, campaign.id, trackingLink.id, {
      botClassification: "BOT",
    });

    const setupClick = await prisma.click.findFirstOrThrow({
      where: { organizationId, botClassification: "HUMAN" },
    });

    const approved = (
      await createConversion(owner.cookie, organizationId, {
        clickId: setupClick.id,
        eventName: "purchase",
        value: 100,
        currency: "USD",
      })
    ).json().conversion;
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions/${approved.id}/approve`,
      headers: { cookie: owner.cookie },
    });

    await createConversion(owner.cookie, organizationId, {
      clickId: setupClick.id,
      eventName: "signup",
    }); // stays PENDING

    // A conversion attributed to a BOT click is not itself invalid (the
    // trigger only cares that attribution matches the click) — included to
    // prove bot-attributed conversions don't silently vanish from the
    // total, they just don't affect the human-click denominator.
    await createConversion(owner.cookie, organizationId, {
      clickId: botClick.id,
      eventName: "purchase",
      value: 5,
      currency: "USD",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/analytics/conversions/summary`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const summary = response.json().summary;

    expect(summary.totalConversions).toBe(3);
    expect(summary.approvedConversions).toBe(1);
    expect(summary.pendingConversions).toBe(2);
    expect(summary.rejectedConversions).toBe(0);
    expect(summary.reversedConversions).toBe(0);
    expect(summary.approvedConversionValue).toBe(100);
    expect(summary.totalConversionValue).toBe(105);
    // 4 HUMAN clicks total (1 from setup + 3 added), 1 BOT click excluded.
    expect(summary.humanClicksInRange).toBe(4);
    // 1 approved / 4 human clicks = 25%.
    expect(summary.conversionRate).toBe(25);
  });

  it("returns zero conversion rate rather than dividing by zero when there are no human clicks", async () => {
    const { owner, organizationId } = await setupOrgWithClick("analytics-zero", "BOT");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/analytics/conversions/summary`,
      headers: { cookie: owner.cookie },
    });
    expect(response.json().summary.humanClicksInRange).toBe(0);
    expect(response.json().summary.conversionRate).toBe(0);
  });

  it("isolates conversion analytics per organization", async () => {
    const orgA = await setupOrgWithClick("analytics-idor-a");
    const orgB = await setupOrgWithClick("analytics-idor-b");
    await createConversion(orgA.owner.cookie, orgA.organizationId, {
      clickId: orgA.click.id,
      eventName: "purchase",
      value: 500,
      currency: "USD",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/analytics/conversions/summary`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(response.json().summary.totalConversions).toBe(0);
    expect(response.json().summary.totalConversionValue).toBe(0);

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgA.organizationId}/analytics/conversions/summary`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
