import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { buildTrackerApp } from "../src/app.js";
import { resetDatabase } from "./db-reset.js";
import { createTrackerFixture } from "./fixtures.js";

/**
 * Phase 12: Google Transparent Click Tracker Certification Preparation.
 *
 * This file exists as a SEPARATE, explicitly-labeled compliance suite —
 * every test below is named after the letter (A-N) it proves from the
 * Phase 12 brief's transparency test matrix, even where the underlying
 * behavior is already covered elsewhere (tracker.routes.test.ts). The
 * point of this file is not new coverage; it's an auditable, one-to-one
 * mapping from "what Google's transparency requirement demands" to "the
 * exact test that proves it," for use as submission evidence — see
 * docs/compliance/google-transparent-click-tracker.md and
 * docs/compliance/google-certification-checklist.md.
 *
 * Every test inspects the immediate HTTP response (status + Location
 * header) directly — none of them use inject()'s automatic redirect
 * following — per the brief's explicit "the test must inspect the
 * immediate response" instruction (Section 15).
 */

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BOT_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";

const REALISTIC_BROWSER_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
};

let app: FastifyInstance;

beforeEach(async () => {
  app ??= await buildTrackerApp({ env: getEnv(), logger: false });
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
});

async function hit(hostname: string, slug: string, query = "", headers: Record<string, string> = {}) {
  return app.inject({
    method: "GET",
    url: `/${slug}${query}`,
    headers: { host: hostname, "user-agent": HUMAN_UA, ...REALISTIC_BROWSER_HEADERS, ...headers },
  });
}

describe("Google transparency compliance matrix", () => {
  it("A. GET /:slug?redirection_url=<url> redirects to EXACTLY that URL, immediate response inspected directly", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/page";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBeGreaterThanOrEqual(300);
    expect(response.statusCode).toBeLessThan(400);
    expect(response.headers.location).toBe(target);
    // No intermediate tracking URL — the Location header IS the final
    // advertiser destination, not another AdstrackIO URL.
    expect(response.headers.location).not.toContain(fixture.hostname);
  });

  it("B. GET /:slug with no redirection_url does NOT fall back to any stored/hidden destination", async () => {
    const fixture = await createTrackerFixture();

    const response = await hit(fixture.hostname, fixture.slug);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    // The stored Destination row's URL must never leak into the response
    // in any form (Location header, body, etc.) when no visible
    // destination was supplied.
    expect(response.body).not.toContain("backend-configured-destination");
  });

  it("C. query parameters on the destination are preserved exactly, including multiple params", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/a?x=1&y=2";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
    const location = new URL(response.headers.location!);
    expect(location.searchParams.get("x")).toBe("1");
    expect(location.searchParams.get("y")).toBe("2");
  });

  it("D. destination URL fragment is preserved", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/path#fragment";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
    expect(new URL(response.headers.location!).hash).toBe("#fragment");
  });

  it("D2. query parameters AND a fragment together are both preserved", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/path?utm_source=ads&utm_campaign=x#section-2";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.headers.location).toBe(target);
  });

  it("E. an unknown tracking slug fails safely (404, no destination leaked)", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/x";

    const response = await hit(
      fixture.hostname,
      "this-slug-does-not-exist",
      `?redirection_url=${encodeURIComponent(target)}`,
    );

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("F. an unverified tracking domain fails safely (404)", async () => {
    const fixture = await createTrackerFixture({ domainVerified: false });
    const target = "https://example.com/x";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("G. an inactive (deactivated) tracking domain fails safely (404)", async () => {
    const fixture = await createTrackerFixture({ domainActive: false });
    const target = "https://example.com/x";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("H. a paused tracking link preserves its existing safe behavior (410, not a silent redirect)", async () => {
    const fixture = await createTrackerFixture({ linkStatus: "PAUSED" });
    const target = "https://example.com/x";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(410);
    expect(response.headers.location).toBeUndefined();
  });

  it("H2. an archived tracking link preserves its existing safe behavior (410, not a silent redirect)", async () => {
    const fixture = await createTrackerFixture({ linkStatus: "ARCHIVED" });
    const target = "https://example.com/x";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(410);
    expect(response.headers.location).toBeUndefined();
  });

  it("I. a BOT request is routed to the configured Safe Page, never the visible redirection_url", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const target = "https://example.com/human-destination";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "user-agent": BOT_UA, accept: "*/*", "accept-language": "", "sec-fetch-mode": "", "sec-fetch-site": "", "sec-fetch-dest": "" },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
    expect(response.headers.location).not.toBe(target);
  });

  it("J. a HUMAN request reaches exactly the visible redirection_url, never the Safe Page", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const target = "https://example.com/human-destination";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("K. a SUSPICIOUS classification follows its existing documented policy — TARGET by default, SAFE_PAGE only if explicitly configured", async () => {
    const policyApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: { classify: () => Promise.resolve({ classification: "SUSPICIOUS", score: 0.5, reasonCodes: [], detectionSource: "fixed-fake" }) },
    });
    try {
      const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
      const target = "https://example.com/x";
      const response = await policyApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      // Default campaign policy for SUSPICIOUS is TARGET — the documented
      // default this test proves, not a guess.
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);
    } finally {
      await policyApp.close();
    }
  });

  it("L. a COUNTRY routing rule only matches when the trusted-edge secret is configured and present", async () => {
    const fixture = await createTrackerFixture();
    await prisma.routingRule.create({
      data: {
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        name: "Country rule",
        status: "ACTIVE",
        priority: 1,
        conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        action: "BLOCK",
      },
    });
    const target = "https://example.com/x";

    // No TRUSTED_EDGE_SECRET is configured in this test environment (see
    // .env.example — unset by default), so a raw geo header from the
    // "client" must never be trusted regardless of its value.
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "cf-ipcountry": "US" },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("M. a client-supplied spoofed country header cannot influence routing even when combined with a fake edge-secret header name", async () => {
    const fixture = await createTrackerFixture();
    await prisma.routingRule.create({
      data: {
        organizationId: fixture.organizationId,
        campaignId: fixture.campaignId,
        name: "Country rule",
        status: "ACTIVE",
        priority: 1,
        conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        action: "BLOCK",
      },
    });
    const target = "https://example.com/x";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "cf-ipcountry": "US", "x-adstrackio-edge-secret": "guessed-or-forged-value" },
    );

    // TRUSTED_EDGE_SECRET is unset in this environment, so
    // isTrustedEdgeRequest is always false regardless of what value a
    // client sends for the secret header — the rule must not match.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("N. affiliate partner attribution is recorded internally but never changes the visible destination", async () => {
    const fixture = await createTrackerFixture({ withAffiliatePartner: true });
    const target = "https://example.com/human-destination";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);

    const click = await prisma.click.findFirst({ where: { trackingLinkId: fixture.trackingLinkId } });
    expect(click?.affiliatePartnerId).toBe(fixture.affiliatePartnerId);
  });

  it("hostname matching is case-insensitive without changing which destination is served", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/x";

    const response = await hit(
      fixture.hostname.toUpperCase(),
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("an unsupported/dangerous protocol in redirection_url is rejected, never redirected to", async () => {
    const fixture = await createTrackerFixture();

    for (const dangerous of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(dangerous)}`);
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("a malformed redirection_url is rejected safely", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent("not a url")}`);
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it("URL semantics are preserved exactly for a realistic Google Ads-style tracking URL", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://advertiser.example.com/landing?gclid=abc123&utm_source=google&utm_medium=cpc#top";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);

    expect(response.headers.location).toBe(target);
  });
});
