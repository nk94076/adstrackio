import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import { buildTrackerApp } from "../src/app.js";
import { resetDatabase } from "./db-reset.js";
import { createTrackerFixture } from "./fixtures.js";

/**
 * Full real-Postgres integration suite for the Phase 3 transparent
 * redirect endpoint. Exercises the actual PrismaTrackingResolver and
 * HeuristicBotDetectionEngine wired together exactly as production does
 * (buildTrackerApp with no overrides) — only fixtures are created
 * directly via Prisma, since apps/tracker has no CRUD endpoints of its
 * own.
 */

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BOT_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";

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
    headers: { host: hostname, "user-agent": HUMAN_UA, ...headers },
  });
}

describe("transparent redirect: success path", () => {
  it("redirects a human visitor to the exact validated https redirection_url", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer?utm_source=ad";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("redirects a human visitor to the exact validated http redirection_url", async () => {
    const fixture = await createTrackerFixture();
    const target = "http://example.com/offer";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("never substitutes the stored Destination for the request's redirection_url", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://totally-different-from-stored-destination.example.com/";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );

    expect(response.headers.location).toBe(target);
    expect(response.headers.location).not.toContain("backend-configured-destination");
  });

  it("uses a temporary redirect status (302), not a permanent one", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(302);
  });
});

describe("transparent redirect: missing/invalid redirection_url", () => {
  it("returns 400 when redirection_url is missing", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(fixture.hostname, fixture.slug);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["javascript:alert(1)", "javascript scheme"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["ftp://example.com/file", "ftp scheme"],
    ["//evil.com/path", "protocol-relative"],
    ["not a url", "malformed"],
    ["https://user:pass@example.com/", "userinfo"],
    ["a".repeat(3000), "extremely long"],
  ])("returns 400 for redirection_url=%s (%s)", async (badUrl) => {
    const fixture = await createTrackerFixture();
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(badUrl)}`,
    );
    expect(response.statusCode).toBe(400);
  });

  it("never issues a redirect for a CRLF injection attempt in redirection_url", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/\r\nSet-Cookie: evil=1")}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    const rawHeaders = JSON.stringify(response.headers);
    expect(rawHeaders).not.toMatch(/\r|\n/);
  });
});

describe("domain gating", () => {
  it("rejects an unknown hostname with 404", async () => {
    const response = await hit("no-such-domain.example.com", "abc123", "?redirection_url=https://example.com/x");
    expect(response.statusCode).toBe(404);
  });

  it("rejects a request on an unverified domain with 404", async () => {
    const fixture = await createTrackerFixture({ domainVerified: false });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      "?redirection_url=https://example.com/x",
    );
    expect(response.statusCode).toBe(404);
  });

  it("rejects a request on an inactive (deactivated) domain with 404", async () => {
    const fixture = await createTrackerFixture({ domainActive: false });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      "?redirection_url=https://example.com/x",
    );
    expect(response.statusCode).toBe(404);
  });
});

describe("link gating", () => {
  it("rejects an unknown slug on a valid domain with 404", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(
      fixture.hostname,
      "no-such-slug",
      "?redirection_url=https://example.com/x",
    );
    expect(response.statusCode).toBe(404);
  });

  it("rejects a paused tracking link with 410", async () => {
    const fixture = await createTrackerFixture({ linkStatus: "PAUSED" });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      "?redirection_url=https://example.com/x",
    );
    expect(response.statusCode).toBe(410);
  });

  it("rejects an archived tracking link with 410", async () => {
    const fixture = await createTrackerFixture({ linkStatus: "ARCHIVED" });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      "?redirection_url=https://example.com/x",
    );
    expect(response.statusCode).toBe(410);
  });
});

describe("bot routing", () => {
  it("routes a known bot user agent to the configured Safe Page instead of the transparent destination", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const target = "https://example.com/offer";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "user-agent": BOT_UA },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("returns a controlled 404 for bot traffic when no Safe Page is configured, never a hidden redirect", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: null });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      { "user-agent": BOT_UA },
    );
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it("routes a normal browser user agent to the transparent destination, not the Safe Page", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const target = "https://example.com/offer";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "user-agent": HUMAN_UA },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("classifies a request with an empty User-Agent header as BOT (never trusts absence as human)", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const response = await app.inject({
      method: "GET",
      url: `/${fixture.slug}?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      headers: { host: fixture.hostname, "user-agent": "" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("cannot be forced to HUMAN or BOT by a client-supplied query parameter", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const target = "https://example.com/offer";

    // A bot UA claiming ?isBot=false / ?bot=false must still be routed as a bot.
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}&isBot=false&bot=false`,
      { "user-agent": BOT_UA },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });
});

describe("click logging", () => {
  it("writes a Click and BotEvent row with the correct organization/campaign/link context", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);

    const clicks = await prisma.click.findMany({ where: { trackingLinkId: fixture.trackingLinkId } });
    expect(clicks).toHaveLength(1);
    const click = clicks[0]!;
    expect(click.organizationId).toBe(fixture.organizationId);
    expect(click.campaignId).toBe(fixture.campaignId);
    expect(click.botClassification).toBe("HUMAN");
    expect(click.ipHash).toBeTruthy();
    expect(click.userAgent).toBe(HUMAN_UA);

    const botEvents = await prisma.botEvent.findMany({ where: { clickId: click.id } });
    expect(botEvents).toHaveLength(1);
    expect(botEvents[0]!.classification).toBe("HUMAN");
  });

  it("never stores a raw IP address", async () => {
    const fixture = await createTrackerFixture();
    await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    const click = await prisma.click.findFirstOrThrow({
      where: { trackingLinkId: fixture.trackingLinkId },
    });
    // Fastify's inject default remote address.
    expect(click.ipHash).not.toContain("127.0.0.1");
    expect(click.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("click ID", () => {
  it("generates a cryptographically random, non-sequential UUID per click", async () => {
    const fixture = await createTrackerFixture();
    const target = `?redirection_url=${encodeURIComponent("https://example.com/offer")}`;

    await hit(fixture.hostname, fixture.slug, target);
    await hit(fixture.hostname, fixture.slug, target);

    const clicks = await prisma.click.findMany({
      where: { trackingLinkId: fixture.trackingLinkId },
      orderBy: { createdAt: "asc" },
    });
    expect(clicks).toHaveLength(2);

    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(clicks[0]!.id).toMatch(uuidV4);
    expect(clicks[1]!.id).toMatch(uuidV4);
    expect(clicks[0]!.id).not.toBe(clicks[1]!.id);
  });

  it("never appends a click ID to the outward transparent redirect URL", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer";
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.headers.location).toBe(target);
  });
});

describe("cross-organization isolation", () => {
  it("resolves Org A's own domain + slug correctly", async () => {
    const fixture = await createTrackerFixture();
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(302);
  });

  it("never resolves Org A's slug through Org B's domain", async () => {
    const orgA = await createTrackerFixture();
    const orgB = await createTrackerFixture();

    const response = await hit(
      orgB.hostname,
      orgA.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(404);
  });

  it("rejects resolution through a data-integrity mistake where a link's campaign belongs to a different org than its domain", async () => {
    const orgA = await createTrackerFixture();
    const orgB = await createTrackerFixture();

    // This shape can never be produced by apps/api (createTrackingLink
    // enforces campaign/domain/destination share an organizationId at
    // write time) — constructed directly here to prove the resolver's
    // defense-in-depth check would catch it if that ever regressed.
    const mismatchedSlug = "mismatched-slug";
    await prisma.trackingLink.create({
      data: {
        campaignId: orgB.campaignId,
        trackingDomainId: orgA.domainId,
        destinationId: orgB.destinationId,
        slug: mismatchedSlug,
        status: "ACTIVE",
      },
    });

    const response = await hit(
      orgA.hostname,
      mismatchedSlug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(404);
  });
});
