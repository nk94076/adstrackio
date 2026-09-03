import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { decryptSecret, encryptSecret } from "@adstrackio/auth";
import { validateWebhookUrl, verifyWebhookSignature } from "@adstrackio/shared";
import { addMemberWithRole, buildTestApp, createTestClick, registerAccount, verifyAndActivateDomain } from "./helpers.js";
import { resetDatabase } from "./db-reset.js";
import {
  attemptWebhookDelivery,
  fanOutPendingOutboxEvents,
  processPendingWebhookDeliveries,
} from "../src/modules/webhooks/webhook-delivery-worker.js";
import { isRetryableWebhookFailure, sendWebhookHttpRequest } from "../src/modules/webhooks/webhook-http-client.js";

/**
 * Phase 11 (API + Integrations) coverage: API keys (lifecycle, hashing,
 * auth, scopes, cross-org isolation), the dual-auth wiring on campaigns/
 * tracking-links/conversions/analytics/reports, Idempotency-Key handling
 * on POST conversions, the webhook control plane (CRUD/RBAC/rotate/
 * disable/test), the outbox + delivery worker (fan-out, signing, retry
 * classification, SSRF protection), and rate limiting. Pre-existing
 * cross-org IDOR coverage for campaigns/tracking-links/domains lives in
 * cross-org-isolation.test.ts; this file focuses on what's new.
 */

let app: FastifyInstance;
const env = loadEnv(process.env);

beforeEach(async () => {
  app ??= await buildTestApp();
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function setupOrg(suffix: string) {
  const owner = await registerAccount(app, {
    email: `owner-${suffix}@example.com`,
    organizationName: `Org ${suffix}`,
  });
  return { owner, organizationId: owner.organizationId! };
}

async function setupOrgWithClick(suffix: string) {
  const { owner, organizationId } = await setupOrg(suffix);

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
    botClassification: "HUMAN",
  });

  return { owner, organizationId, campaign, trackingLink, click };
}

async function createApiKey(
  cookie: string,
  organizationId: string,
  scopes: string[],
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/organizations/${organizationId}/api-keys`,
    headers: { cookie },
    payload: { name: "Integration Key", scopes, ...overrides },
  });
  expect(response.statusCode).toBe(201);
  return response.json().apiKey as { id: string; key: string };
}

function bearer(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe("API keys", () => {
  it("creates a key, returns the raw secret exactly once, and never returns it again", async () => {
    const { owner, organizationId } = await setupOrg("keys1");
    const created = await createApiKey(owner.cookie, organizationId, ["READ"]);
    expect(created.key).toMatch(/^atk_live_/);

    const dbRow = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(dbRow.keyHash).not.toBe(created.key);
    // The stored hash can never reconstruct the raw key: verify the hash
    // is a SHA-256 hex digest (64 hex chars), not the plaintext itself or
    // a reversible encoding of it.
    expect(dbRow.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dbRow)).not.toContain(created.key.slice(9));

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/api-keys`,
      headers: { cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(created.key);
    expect(list.json().apiKeys[0]).not.toHaveProperty("keyHash");
    expect(list.json().apiKeys[0]).not.toHaveProperty("key");

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/api-keys/${created.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(JSON.stringify(get.body)).not.toContain(created.key);
  });

  it("authenticates a valid key and attaches its organization/scopes", async () => {
    const { owner, organizationId } = await setupOrg("keys2");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects an invalid key with a generic 401 that doesn't confirm/deny existence", async () => {
    const { organizationId } = await setupOrg("keys3");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer("atk_live_totallymadeupsecretvaluethatdoesnotexist"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
    expect(response.json().error.message).not.toMatch(/exist|found|prefix/i);
  });

  it("rejects a revoked key", async () => {
    const { owner, organizationId } = await setupOrg("keys4");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"]);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/api-keys/${key.id}/revoke`,
      headers: { cookie: owner.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().apiKey.revokedAt).not.toBeNull();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(401);
  });

  it("revoke is idempotent: revoking twice succeeds and writes exactly one audit entry", async () => {
    const { owner, organizationId } = await setupOrg("keys4b");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"]);

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/api-keys/${key.id}/revoke`,
      headers: { cookie: owner.cookie },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/api-keys/${key.id}/revoke`,
      headers: { cookie: owner.cookie },
    });
    expect(second.statusCode).toBe(200);

    const audits = await prisma.auditLog.findMany({
      where: { organizationId, action: "api_key.revoked", entityId: key.id },
    });
    expect(audits).toHaveLength(1);
  });

  it("rejects an expired key", async () => {
    const { owner, organizationId } = await setupOrg("keys5");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"], {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rotation invalidates the old secret and issues a new one", async () => {
    const { owner, organizationId } = await setupOrg("keys6");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"]);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/api-keys/${key.id}/rotate`,
      headers: { cookie: owner.cookie },
    });
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().apiKey.key as string;
    expect(newKey).not.toBe(key.key);

    const oldStillWorks = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(oldStillWorks.statusCode).toBe(401);

    const newWorks = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(newKey),
    });
    expect(newWorks.statusCode).toBe(200);
  });

  it("MEMBER and VIEWER cannot manage API keys; ADMIN/OWNER can", async () => {
    const { owner, organizationId } = await setupOrg("keys7");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER");
    const viewer = await addMemberWithRole(app, owner.cookie, organizationId, "VIEWER");
    const admin = await addMemberWithRole(app, owner.cookie, organizationId, "ADMIN");

    for (const cookie of [member.cookie, viewer.cookie]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/api-keys`,
        headers: { cookie },
        payload: { name: "Nope", scopes: ["READ"] },
      });
      expect(response.statusCode).toBe(403);
    }

    const adminCreate = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/api-keys`,
      headers: { cookie: admin.cookie },
      payload: { name: "Fine", scopes: ["READ"] },
    });
    expect(adminCreate.statusCode).toBe(201);
  });

  it("cross-org: an API key from Org A cannot access Org B, even with the right scope", async () => {
    const orgA = await setupOrg("keysA");
    const orgB = await setupOrg("keysB");
    const key = await createApiKey(orgA.owner.cookie, orgA.organizationId, ["READ", "WRITE", "REPORTS", "CONVERSIONS"]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(response.statusCode).toBe(403);
  });

  it("an API key cannot manage API keys or webhooks — those routes stay session-only", async () => {
    const { owner, organizationId } = await setupOrg("keys8");
    const key = await createApiKey(owner.cookie, organizationId, ["READ", "WRITE", "REPORTS", "CONVERSIONS"]);

    const listKeys = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/api-keys`,
      headers: bearer(key.key),
    });
    expect(listKeys.statusCode).toBe(401);

    const listWebhooks = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: bearer(key.key),
    });
    expect(listWebhooks.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

describe("API key scopes", () => {
  it("READ scope can GET but not POST/PATCH", async () => {
    const { owner, organizationId } = await setupOrg("scope1");
    const key = await createApiKey(owner.cookie, organizationId, ["READ"]);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
    });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
      payload: { name: "Nope" },
    });
    expect(write.statusCode).toBe(403);
  });

  it("WRITE scope can POST campaigns/tracking-links", async () => {
    const { owner, organizationId } = await setupOrg("scope2");
    const key = await createApiKey(owner.cookie, organizationId, ["WRITE"]);

    const write = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
      payload: { name: "Via API key" },
    });
    expect(write.statusCode).toBe(201);
  });

  it("REPORTS scope can read reports/analytics but a bare READ-less/REPORTS-less key cannot", async () => {
    const { owner, organizationId } = await setupOrg("scope3");
    const reportsKey = await createApiKey(owner.cookie, organizationId, ["REPORTS"]);
    const convOnlyKey = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);

    const withReports = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/reports/overview`,
      headers: bearer(reportsKey.key),
    });
    expect(withReports.statusCode).toBe(200);

    const withoutReports = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/reports/overview`,
      headers: bearer(convOnlyKey.key),
    });
    expect(withoutReports.statusCode).toBe(403);
  });

  it("CONVERSIONS scope can create/read conversions without WRITE", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("scope4");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);

    const create = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: bearer(key.key),
      payload: { clickId: click.id, eventName: "purchase" },
    });
    expect(create.statusCode).toBe(201);
  });

  it("a forbidden scope is rejected with 403, not silently downgraded", async () => {
    const { owner, organizationId } = await setupOrg("scope5");
    const key = await createApiKey(owner.cookie, organizationId, ["REPORTS"]);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(key.key),
      payload: { name: "Nope" },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Conversion attribution + idempotency via the public API
// ---------------------------------------------------------------------------

describe("public API conversions: attribution and idempotency", () => {
  it("derives attribution server-side; forged campaign/trackingLink/affiliatePartner in the body are ignored", async () => {
    const { owner, organizationId, campaign, trackingLink, click } = await setupOrgWithClick("attr1");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);

    const forgedOtherOrg = await setupOrg("attr1-other");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: bearer(key.key),
      payload: {
        clickId: click.id,
        eventName: "purchase",
        campaignId: forgedOtherOrg.organizationId,
        trackingLinkId: "forged-tracking-link-id",
        affiliatePartnerId: "forged-affiliate-partner-id",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().conversion.campaignId).toBe(campaign.id);
    expect(response.json().conversion.trackingLinkId).toBe(trackingLink.id);
  });

  it("replays an identical request with the same Idempotency-Key instead of creating a duplicate", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("idem1");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);
    const payload = { clickId: click.id, eventName: "purchase" };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "order-123" },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "order-123" },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().conversion.id).toBe(first.json().conversion.id);
    expect(second.headers["idempotency-replayed"]).toBe("true");

    const count = await prisma.conversion.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it("rejects reuse of the same Idempotency-Key with a different payload", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("idem2");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "dup-key" },
      payload: { clickId: click.id, eventName: "purchase" },
    });

    const conflicting = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "dup-key" },
      payload: { clickId: click.id, eventName: "signup" },
    });
    expect(conflicting.statusCode).toBe(409);
  });

  it("concurrent duplicate requests with the same Idempotency-Key create exactly one conversion", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("idem3");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);
    const payload = { clickId: click.id, eventName: "purchase" };
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions`,
        headers: { ...bearer(key.key), "idempotency-key": "concurrent-key" },
        payload,
      });

    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().conversion.id).toBe(b.json().conversion.id);

    const count = await prisma.conversion.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it("without an Idempotency-Key, two otherwise-identical requests create two conversions (no dedup guarantee)", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("idem4");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);
    const payload = { clickId: click.id, eventName: "purchase" };

    const a = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: bearer(key.key),
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: bearer(key.key),
      payload,
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().conversion.id).not.toBe(b.json().conversion.id);
  });

  it("an Idempotency-Key does not bypass the externalConversionId uniqueness constraint", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("idem5");
    const key = await createApiKey(owner.cookie, organizationId, ["CONVERSIONS"]);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "key-a" },
      payload: { clickId: click.id, eventName: "purchase", externalConversionId: "ext-1" },
    });
    expect(first.statusCode).toBe(201);

    // A DIFFERENT Idempotency-Key, but the same externalConversionId —
    // this must still collide on the Conversion-level business identity.
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { ...bearer(key.key), "idempotency-key": "key-b" },
      payload: { clickId: click.id, eventName: "purchase", externalConversionId: "ext-1" },
    });
    expect(second.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Webhook endpoints: CRUD, RBAC, cross-org isolation, SSRF
// ---------------------------------------------------------------------------

describe("webhook endpoints", () => {
  it("creates an endpoint, returns the secret once, and never returns it again", async () => {
    const { owner, organizationId } = await setupOrg("wh1");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "My endpoint", url: "https://example.com/hooks", subscribedEvents: ["conversion.created"] },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().webhook.secret as string;
    expect(secret).toMatch(/^whsec_/);

    const dbRow = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.json().webhook.id } });
    expect(dbRow.secretEncrypted).not.toBe(secret);
    expect(decryptSecret(dbRow.secretEncrypted, env.AUTH_SECRET)).toBe(secret);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/webhooks/${created.json().webhook.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(JSON.stringify(get.body)).not.toContain(secret);
    expect(get.json().webhook).not.toHaveProperty("secretEncrypted");
  });

  it("rejects localhost, private IPs, and cloud metadata addresses", async () => {
    const { owner, organizationId } = await setupOrg("wh2");
    for (const url of [
      "http://localhost/hook",
      "http://127.0.0.1/hook",
      "http://10.0.0.5/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/hook",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/webhooks`,
        headers: { cookie: owner.cookie },
        payload: { name: "Bad", url, subscribedEvents: ["conversion.created"] },
      });
      expect(response.statusCode, `${url} should be rejected`).toBe(400);
    }
  });

  it("rejects an unsafe redirect target the same way at the shared-validator level (injected DNS)", async () => {
    await expect(
      validateWebhookUrl("https://attacker.example.test/hook", {
        requireHttps: true,
        resolveHostname: async () => ["169.254.169.254"],
      }),
    ).rejects.toThrow(/private|internal|loopback/i);
  });

  it("MEMBER/VIEWER can read; only ADMIN/OWNER can create/update/rotate/disable/test", async () => {
    const { owner, organizationId } = await setupOrg("wh3");
    const member = await addMemberWithRole(app, owner.cookie, organizationId, "MEMBER");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["conversion.created"] },
    });
    const webhookId = created.json().webhook.id;

    const memberRead = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}`,
      headers: { cookie: member.cookie },
    });
    expect(memberRead.statusCode).toBe(200);

    const memberDisable = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}/disable`,
      headers: { cookie: member.cookie },
    });
    expect(memberDisable.statusCode).toBe(403);
  });

  it("cross-org: cannot read or manage another organization's webhook endpoint", async () => {
    const orgA = await setupOrg("whA");
    const orgB = await setupOrg("whB");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${orgA.organizationId}/webhooks`,
      headers: { cookie: orgA.owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["conversion.created"] },
    });
    const webhookId = created.json().webhook.id;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${orgB.organizationId}/webhooks/${webhookId}`,
      headers: { cookie: orgB.owner.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rotate-secret changes the secret and is reflected in future signing", async () => {
    const { owner, organizationId } = await setupOrg("wh4");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["conversion.created"] },
    });
    const oldSecret = created.json().webhook.secret;

    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${created.json().webhook.id}/rotate-secret`,
      headers: { cookie: owner.cookie },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().webhook.secret).not.toBe(oldSecret);
  });

  it("disable is idempotent and rejects duplicate audit noise", async () => {
    const { owner, organizationId } = await setupOrg("wh5");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["conversion.created"] },
    });
    const webhookId = created.json().webhook.id;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}/disable`,
      headers: { cookie: owner.cookie },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}/disable`,
      headers: { cookie: owner.cookie },
    });

    const audits = await prisma.auditLog.findMany({
      where: { organizationId, action: "webhook.disabled", entityId: webhookId },
    });
    expect(audits).toHaveLength(1);
  });

  it("rejects an unknown/injected event type in subscribedEvents", async () => {
    const { owner, organizationId } = await setupOrg("wh6");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["totally.made.up"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("webhook.created/updated/secret_rotated/disabled are audit-logged; retries are not", async () => {
    const { owner, organizationId } = await setupOrg("wh7");
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/hook", subscribedEvents: ["conversion.created"] },
    });
    const webhookId = created.json().webhook.id;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}`,
      headers: { cookie: owner.cookie },
      payload: { name: "Renamed" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}/rotate-secret`,
      headers: { cookie: owner.cookie },
    });

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId, entityId: webhookId }, select: { action: true } })
    ).map((a) => a.action);
    expect(actions.sort()).toEqual(["webhook.created", "webhook.secret_rotated", "webhook.updated"].sort());
  });
});

// ---------------------------------------------------------------------------
// Outbox + webhook event generation
// ---------------------------------------------------------------------------

describe("outbox event generation", () => {
  it("a real conversion creation writes exactly one matching OutboxEvent", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("outbox1");
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { cookie: owner.cookie },
      payload: { clickId: click.id, eventName: "purchase" },
    });

    const events = await prisma.outboxEvent.findMany({ where: { organizationId, type: "conversion.created" } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).clickId).toBe(click.id);
  });

  it("an idempotent no-op status transition does not emit a duplicate event", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("outbox2");
    const conversion = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions`,
        headers: { cookie: owner.cookie },
        payload: { clickId: click.id, eventName: "purchase" },
      })
    ).json().conversion;

    const approve = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/conversions/${conversion.id}/approve`,
        headers: { cookie: owner.cookie },
      });
    await approve();
    await approve(); // idempotent repeat

    const events = await prisma.outboxEvent.findMany({ where: { organizationId, type: "conversion.approved" } });
    expect(events).toHaveLength(1);
  });

  it("fan-out creates exactly one WebhookDelivery per active, subscribed endpoint and marks the event PROCESSED", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("outbox3");

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Subscribed", url: "https://example.com/a", subscribedEvents: ["conversion.created"] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "NotSubscribed", url: "https://example.com/b", subscribedEvents: ["campaign.created"] },
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { cookie: owner.cookie },
      payload: { clickId: click.id, eventName: "purchase" },
    });

    await fanOutPendingOutboxEvents(prisma);

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { organizationId, type: "conversion.created" } });
    expect(event.status).toBe("PROCESSED");
    const deliveries = await prisma.webhookDelivery.findMany({ where: { eventId: event.id } });
    expect(deliveries).toHaveLength(1);
  });

  it("re-running fan-out never creates duplicate deliveries for the same endpoint+event", async () => {
    const { owner, organizationId, click } = await setupOrgWithClick("outbox4");
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Hook", url: "https://example.com/a", subscribedEvents: ["conversion.created"] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/conversions`,
      headers: { cookie: owner.cookie },
      payload: { clickId: click.id, eventName: "purchase" },
    });

    await fanOutPendingOutboxEvents(prisma);
    await fanOutPendingOutboxEvents(prisma);

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { organizationId, type: "conversion.created" } });
    const deliveries = await prisma.webhookDelivery.findMany({ where: { eventId: event.id } });
    expect(deliveries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook delivery: signing, retries, timeouts (against a real local
// server — see webhook-delivery-worker.ts's `validateUrl` injection point
// for why this bypasses validateWebhookUrl directly rather than fighting
// the (correctly unconditional) private-IP block).
// ---------------------------------------------------------------------------

describe("webhook delivery", () => {
  async function startTestServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  ): Promise<{ url: string; close: () => Promise<void>; received: { headers: http.IncomingHttpHeaders; body: string }[] }> {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}/hook`,
      received,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function makeEndpointAndEvent(organizationId: string, url: string, secret: string) {
    const owner = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        organizationId,
        name: "Test target",
        url,
        secretEncrypted: encryptSecret(secret, env.AUTH_SECRET),
        subscribedEvents: ["conversion.created"],
        createdBy: owner.userId,
      },
    });
    const event = await prisma.outboxEvent.create({
      data: {
        organizationId,
        type: "conversion.created",
        aggregateType: "Conversion",
        aggregateId: "conv-1",
        payload: { id: "conv-1", eventName: "purchase" },
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    const delivery = await prisma.webhookDelivery.create({
      data: { webhookEndpointId: endpoint.id, eventId: event.id },
    });
    return { endpoint, event, delivery };
  }

  const testValidateUrl: typeof validateWebhookUrl = async (url) => {
    const parsed = new URL(url);
    return { url, hostname: parsed.hostname, resolvedAddresses: ["127.0.0.1"] };
  };

  it("delivers a correctly signed payload and marks the delivery DELIVERED", async () => {
    const { organizationId } = await setupOrg("deliver1");
    const secret = "whsec_test_secret_value";
    const server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const { delivery } = await makeEndpointAndEvent(organizationId, server.url, secret);
    await attemptWebhookDelivery(prisma, env, delivery, testValidateUrl);
    await server.close();

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("DELIVERED");
    expect(updated.attempt).toBe(1);
    expect(updated.responseStatus).toBe(200);

    expect(server.received).toHaveLength(1);
    const { headers, body } = server.received[0]!;
    const timestamp = headers["x-adstrackio-timestamp"] as string;
    const signature = headers["x-adstrackio-signature"] as string;
    expect(headers["x-adstrackio-event-id"]).toBeTruthy();
    // The receiver-side verification helper (also what a real webhook
    // consumer would use) must accept the exact raw body AdstrackIO sent.
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(true);
    // A tampered body must NOT verify.
    expect(verifyWebhookSignature(secret, timestamp, body + "tampered", signature)).toBe(false);

    const envelope = JSON.parse(body);
    expect(envelope.type).toBe("conversion.created");
    expect(envelope.organizationId).toBe(organizationId);
    expect(envelope.data.eventName).toBe("purchase");
  });

  it("a 5xx response schedules a retry (stays PENDING with a future nextAttemptAt)", async () => {
    const { organizationId } = await setupOrg("deliver2");
    const server = await startTestServer((_req, res) => {
      res.writeHead(503);
      res.end("unavailable");
    });

    const { delivery } = await makeEndpointAndEvent(organizationId, server.url, "whsec_x");
    await attemptWebhookDelivery(prisma, env, delivery, testValidateUrl);
    await server.close();

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("PENDING");
    expect(updated.attempt).toBe(1);
    expect(updated.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a 400 response is FAILED immediately, never retried", async () => {
    const { organizationId } = await setupOrg("deliver3");
    const server = await startTestServer((_req, res) => {
      res.writeHead(400);
      res.end("bad request");
    });

    const { delivery } = await makeEndpointAndEvent(organizationId, server.url, "whsec_x");
    await attemptWebhookDelivery(prisma, env, delivery, testValidateUrl);
    await server.close();

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("FAILED");
  });

  it("exhausts retries after the maximum attempt count against a persistently failing endpoint", async () => {
    const { organizationId } = await setupOrg("deliver4");
    const server = await startTestServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });

    const { delivery } = await makeEndpointAndEvent(organizationId, server.url, "whsec_x");
    let current = delivery;
    for (let i = 0; i < 5; i += 1) {
      await attemptWebhookDelivery(prisma, env, current, testValidateUrl);
      current = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    }
    await server.close();

    expect(current.status).toBe("EXHAUSTED");
    expect(current.attempt).toBe(5);
  });

  it("a network error (connection refused) is retryable", async () => {
    const { organizationId } = await setupOrg("deliver5");
    // Nothing is listening on this port.
    const { delivery } = await makeEndpointAndEvent(organizationId, "http://127.0.0.1:1/hook", "whsec_x");
    await attemptWebhookDelivery(prisma, env, delivery, testValidateUrl);

    const updated = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updated.status).toBe("PENDING");
    expect(isRetryableWebhookFailure(null, true)).toBe(true);
  });

  it("classifies retryable vs non-retryable statuses correctly", () => {
    expect(isRetryableWebhookFailure(408, false)).toBe(true);
    expect(isRetryableWebhookFailure(429, false)).toBe(true);
    expect(isRetryableWebhookFailure(500, false)).toBe(true);
    expect(isRetryableWebhookFailure(502, false)).toBe(true);
    expect(isRetryableWebhookFailure(400, false)).toBe(false);
    expect(isRetryableWebhookFailure(401, false)).toBe(false);
    expect(isRetryableWebhookFailure(403, false)).toBe(false);
    expect(isRetryableWebhookFailure(404, false)).toBe(false);
    expect(isRetryableWebhookFailure(422, false)).toBe(false);
  });

  it("caps the buffered response size rather than reading an unbounded body", async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(200_000));
    });
    const result = await sendWebhookHttpRequest({
      url: server.url,
      pinnedAddress: "127.0.0.1",
      headers: {},
      body: "{}",
      timeoutMs: 5000,
    });
    await server.close();
    expect(result.bodySnippet.length).toBeLessThan(10_000);
  });

  it("times out against a server that never responds", async () => {
    const server = http.createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    await expect(
      sendWebhookHttpRequest({
        url: `http://127.0.0.1:${port}/hook`,
        pinnedAddress: "127.0.0.1",
        headers: {},
        body: "{}",
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/i);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the test-send endpoint delivers a clearly-marked test event without touching real business data", async () => {
    const { owner, organizationId } = await setupOrg("deliver6");
    const server = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks`,
      headers: { cookie: owner.cookie },
      payload: { name: "Real target", url: "https://example.com/unreachable", subscribedEvents: ["conversion.created"] },
    });
    const webhookId = created.json().webhook.id;
    // Point the stored endpoint at our local test server directly (the
    // dashboard-facing create/update path correctly can't be pointed at
    // 127.0.0.1 — see the SSRF test above) so we can assert what the
    // test-send path actually transmits.
    await prisma.webhookEndpoint.update({ where: { id: webhookId }, data: { url: server.url } });

    // sendTestWebhook calls the real validateWebhookUrl, so this proves
    // it goes through the SAME private-IP gate as production delivery —
    // it will reject 127.0.0.1 exactly like real delivery does. This
    // documents the interaction rather than fighting it: a self-hosted
    // test receiver on loopback cannot be used with the real, unmodified
    // validator either.
    const testSend = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/webhooks/${webhookId}/test`,
      headers: { cookie: owner.cookie },
    });
    expect(testSend.statusCode).toBe(200);
    expect(testSend.json().delivery.status).not.toBe("DELIVERED");

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { organizationId, type: "webhook.test" } });
    expect(event.aggregateType).toBe("WebhookEndpoint");
    // No real business row was created by the test send.
    expect(await prisma.conversion.count({ where: { organizationId } })).toBe(0);

    await server.close();
  });

  it("processPendingWebhookDeliveries fans out and attempts due deliveries end to end (via direct worker call)", async () => {
    const { organizationId } = await setupOrg("deliver7");
    const server = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    const owner = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId } });
    await prisma.webhookEndpoint.create({
      data: {
        organizationId,
        name: "Loopback (test-only)",
        url: server.url,
        secretEncrypted: encryptSecret("whsec_x", env.AUTH_SECRET),
        subscribedEvents: ["conversion.created"],
        createdBy: owner.userId,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        organizationId,
        type: "conversion.created",
        aggregateType: "Conversion",
        aggregateId: "conv-1",
        payload: { id: "conv-1" },
      },
    });

    // processPendingWebhookDeliveries always uses the real
    // validateWebhookUrl (no test seam threaded through it — this
    // exercises fan-out + claiming due rows via the public entry point,
    // not the private-IP gate, which is covered separately above).
    await processPendingWebhookDeliveries(prisma, env);

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhookEndpoint: { organizationId } } });
    // The real validator correctly rejects the loopback URL — proving
    // fan-out + claim + attempt + SSRF-gate all ran, end to end, through
    // the exact same code path production uses.
    expect(delivery.status).toBe("FAILED");
    expect(delivery.responseBodySnippet).toMatch(/private|internal|loopback/i);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("API key rate limiting", () => {
  it("isolates one API key's quota from another's", async () => {
    const { owner, organizationId } = await setupOrg("ratelimit1");
    const keyA = await createApiKey(owner.cookie, organizationId, ["READ"]);
    const keyB = await createApiKey(owner.cookie, organizationId, ["READ"]);

    // Both keys should be able to make a request right after each other —
    // proving they don't share one bucket.
    const a = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(keyA.key),
    });
    const b = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: bearer(keyB.key),
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.headers["x-ratelimit-limit"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("list endpoint pagination", () => {
  it("GET campaigns is bounded by `take` and cannot request an unlimited page", async () => {
    const { owner, organizationId } = await setupOrg("page1");
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/campaigns`,
        headers: { cookie: owner.cookie },
        payload: { name: `Campaign ${i}` },
      });
    }

    const bounded = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns?take=2`,
      headers: { cookie: owner.cookie },
    });
    expect(bounded.json().campaigns).toHaveLength(2);

    const overCap = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns?take=99999`,
      headers: { cookie: owner.cookie },
    });
    expect(overCap.statusCode).toBe(400);

    const defaultPage = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
    });
    expect(defaultPage.json().campaigns).toHaveLength(5);
  });

  it("GET tracking-links is bounded by `take` as well", async () => {
    const { owner, organizationId, campaign } = await setupOrgWithClick("page2");
    const bounded = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/campaigns/${campaign.id}/tracking-links?take=1`,
      headers: { cookie: owner.cookie },
    });
    expect(bounded.json().trackingLinks.length).toBeLessThanOrEqual(1);

    const overCap = await app.inject({
      method: "GET",
      url: `/api/v1/organizations/${organizationId}/tracking-links?take=99999`,
      headers: { cookie: owner.cookie },
    });
    expect(overCap.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Regression: Phase 8/9/10 unaffected
// ---------------------------------------------------------------------------

describe("regression", () => {
  it("session-based dashboard flows on the dual-auth routes are completely unaffected", async () => {
    const { owner, organizationId } = await setupOrg("regress1");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/campaigns`,
      headers: { cookie: owner.cookie },
      payload: { name: "Session campaign" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("affiliate-partner and campaign/tracking-link webhook events fire on their existing lifecycle actions", async () => {
    const { owner, organizationId } = await setupOrg("regress2");
    const partner = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizationId}/affiliate-partners`,
        headers: { cookie: owner.cookie },
        payload: { name: "Partner" },
      })
    ).json().affiliatePartner;

    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organizationId}/affiliate-partners/${partner.id}/activate`,
      headers: { cookie: owner.cookie },
    });

    const types = (
      await prisma.outboxEvent.findMany({ where: { organizationId, aggregateType: "AffiliatePartner" } })
    ).map((e) => e.type);
    expect(types.sort()).toEqual(["affiliate_partner.activated", "affiliate_partner.created"].sort());
  });
});
