import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getEnv } from "@adstrackio/config";
import { prisma } from "@adstrackio/database";
import type { Prisma } from "@adstrackio/database";
import { buildTrackerApp } from "../src/app.js";
import { resetDatabase } from "./db-reset.js";
import { createTrackerFixture } from "./fixtures.js";

/** Directly inserts a RoutingRule (Phase 8) against a fixture's campaign —
 * apps/tracker has no CRUD endpoints of its own, same rationale as
 * createTrackerFixture's own doc comment. */
async function createRoutingRule(
  organizationId: string,
  campaignId: string,
  overrides: {
    priority?: number;
    conditions?: unknown[];
    action?: "TARGET" | "SAFE_PAGE" | "BLOCK";
    status?: "ACTIVE" | "INACTIVE";
    name?: string;
  } = {},
) {
  return prisma.routingRule.create({
    data: {
      organizationId,
      campaignId,
      name: overrides.name ?? "Test rule",
      status: overrides.status ?? "ACTIVE",
      priority: overrides.priority ?? 1,
      conditions: (overrides.conditions ?? []) as Prisma.InputJsonValue,
      action: overrides.action ?? "BLOCK",
    },
  });
}

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

// Headers a real Chrome browser sends by default on a top-level
// navigation. The Phase 5 detection engine treats a browser-claiming UA
// with none of these as a (soft) automation signal, so `hit()` includes
// them by default to model genuine human traffic — matching what every
// browser actually sends, not a synthetic bare-minimum request no real
// visitor ever makes. Tests that specifically want to simulate a
// script/bot pass their own headers, which override these via the spread
// below.
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

describe("affiliate partner attribution (Phase 9)", () => {
  it("a click through a link attributed to a partner carries that partner's id", async () => {
    const fixture = await createTrackerFixture({ withAffiliatePartner: true });
    expect(fixture.affiliatePartnerId).toBeTruthy();

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(302);

    const click = await prisma.click.findFirstOrThrow({
      where: { trackingLinkId: fixture.trackingLinkId },
    });
    expect(click.affiliatePartnerId).toBe(fixture.affiliatePartnerId);
  });

  it("a click through an ordinary (non-affiliate) link has a null affiliatePartnerId", async () => {
    const fixture = await createTrackerFixture();
    expect(fixture.affiliatePartnerId).toBeNull();

    await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );

    const click = await prisma.click.findFirstOrThrow({
      where: { trackingLinkId: fixture.trackingLinkId },
    });
    expect(click.affiliatePartnerId).toBeNull();
  });

  it("cannot be forced to attribute to an arbitrary partner via a client-supplied query parameter", async () => {
    const fixture = await createTrackerFixture();
    const forgedPartnerId = "cl000000000000000000000forged";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}&affiliatePartnerId=${forgedPartnerId}`,
    );
    expect(response.statusCode).toBe(302);

    const click = await prisma.click.findFirstOrThrow({
      where: { trackingLinkId: fixture.trackingLinkId },
    });
    expect(click.affiliatePartnerId).toBeNull();
  });

  it("does not change the visible transparent redirect destination for an affiliate-attributed link", async () => {
    const fixture = await createTrackerFixture({ withAffiliatePartner: true });
    const target = "https://example.com/exact-visible-destination";

    const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
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

describe("enrichment failure isolation (Phase 4)", () => {
  it("still redirects when the UserAgentParser throws", async () => {
    const enrichmentFailureApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      userAgentParser: {
        parse: () => {
          throw new Error("boom: UA parser exploded");
        },
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await enrichmentFailureApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);
    } finally {
      await enrichmentFailureApp.close();
    }
  });

  it("still redirects when the GeoLocationProvider rejects", async () => {
    const enrichmentFailureApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      geoLocationProvider: {
        lookup: () => Promise.reject(new Error("boom: geo provider rejected")),
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await enrichmentFailureApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);

      const click = await prisma.click.findFirstOrThrow({
        where: { trackingLinkId: fixture.trackingLinkId },
      });
      expect(click.country).toBeNull();
    } finally {
      await enrichmentFailureApp.close();
    }
  });

  it("still redirects immediately when the GeoLocationProvider never resolves (not just when it rejects)", async () => {
    // The lookup's promise is deliberately never settled during this test.
    // If the redirect handler awaited geo enrichment anywhere on its path,
    // this `inject()` call would hang until the test's own timeout — the
    // strongest possible proof that a slow/hanging geo provider cannot
    // delay or block the redirect, independent of any wall-clock margin.
    const neverResolvingGeoApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      geoLocationProvider: {
        lookup: () =>
          new Promise(() => {
            /* deliberately never settles */
          }),
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await neverResolvingGeoApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);

      const click = await prisma.click.findFirstOrThrow({
        where: { trackingLinkId: fixture.trackingLinkId },
      });
      expect(click.country).toBeNull();
    } finally {
      await neverResolvingGeoApp.close();
    }
  });
});

/** A BotDetectionEngine fake that always returns the given classification
 * — decouples "does routing obey the configured policy" (this file) from
 * "does the heuristic engine compute the right verdict" (covered
 * separately in heuristic-bot-detection-engine.test.ts). */
function fixedClassificationEngine(
  classification: "HUMAN" | "BOT" | "SUSPICIOUS" | "UNKNOWN",
  reasonCodes: string[] = [],
) {
  return {
    classify: () =>
      Promise.resolve({ classification, score: 0.5, reasonCodes, detectionSource: "fixed-fake" }),
  };
}

describe("SUSPICIOUS/UNKNOWN routing policy (Phase 5)", () => {
  it.each(["SUSPICIOUS", "UNKNOWN"] as const)(
    "%s with the default (TARGET) policy routes to the transparent destination",
    async (classification) => {
      const policyApp = await buildTrackerApp({
        env: getEnv(),
        logger: false,
        botDetectionEngine: fixedClassificationEngine(classification),
      });
      try {
        const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
        const target = "https://example.com/offer";
        const response = await policyApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
          headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(target);
      } finally {
        await policyApp.close();
      }
    },
  );

  it.each(["SUSPICIOUS", "UNKNOWN"] as const)(
    "%s with a SAFE_PAGE policy routes to the campaign's Safe Page",
    async (classification) => {
      const policyOverrides =
        classification === "SUSPICIOUS"
          ? { suspiciousTrafficPolicy: "SAFE_PAGE" as const }
          : { unknownTrafficPolicy: "SAFE_PAGE" as const };
      const policyApp = await buildTrackerApp({
        env: getEnv(),
        logger: false,
        botDetectionEngine: fixedClassificationEngine(classification),
      });
      try {
        const fixture = await createTrackerFixture({
          safePageUrl: "https://safe.example.com/",
          ...policyOverrides,
        });
        const target = "https://example.com/offer";
        const response = await policyApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
          headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("https://safe.example.com/");
      } finally {
        await policyApp.close();
      }
    },
  );

  it.each(["SUSPICIOUS", "UNKNOWN"] as const)(
    "%s with a BLOCK policy returns a controlled 404, never the transparent destination or Safe Page",
    async (classification) => {
      const policyOverrides =
        classification === "SUSPICIOUS"
          ? { suspiciousTrafficPolicy: "BLOCK" as const }
          : { unknownTrafficPolicy: "BLOCK" as const };
      const policyApp = await buildTrackerApp({
        env: getEnv(),
        logger: false,
        botDetectionEngine: fixedClassificationEngine(classification),
      });
      try {
        const fixture = await createTrackerFixture({
          safePageUrl: "https://safe.example.com/",
          ...policyOverrides,
        });
        const response = await policyApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
          headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
        });
        expect(response.statusCode).toBe(404);
        expect(response.headers.location).toBeUndefined();
      } finally {
        await policyApp.close();
      }
    },
  );

  it("BLOCK policy returns a controlled 404 even when a Safe Page IS configured (never falls back to it)", async () => {
    const policyApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: fixedClassificationEngine("SUSPICIOUS"),
    });
    try {
      const fixture = await createTrackerFixture({
        safePageUrl: "https://safe.example.com/",
        suspiciousTrafficPolicy: "BLOCK",
      });
      const response = await policyApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await policyApp.close();
    }
  });
});

describe("Safe Page cannot be overridden by client input (Phase 5)", () => {
  it("a BOT request's attacker-controlled redirection_url never leaks into the Safe Page redirect", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const attackerUrl = "https://attacker.example/phish";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(attackerUrl)}`,
      { "user-agent": BOT_UA },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
    expect(response.headers.location).not.toBe(attackerUrl);
  });

  it.each(["SUSPICIOUS", "UNKNOWN"] as const)(
    "a %s request with a SAFE_PAGE policy also ignores an attacker-controlled redirection_url",
    async (classification) => {
      const policyOverrides =
        classification === "SUSPICIOUS"
          ? { suspiciousTrafficPolicy: "SAFE_PAGE" as const }
          : { unknownTrafficPolicy: "SAFE_PAGE" as const };
      const policyApp = await buildTrackerApp({
        env: getEnv(),
        logger: false,
        botDetectionEngine: fixedClassificationEngine(classification),
      });
      try {
        const fixture = await createTrackerFixture({
          safePageUrl: "https://safe.example.com/",
          ...policyOverrides,
        });
        const attackerUrl = "https://attacker.example/phish";
        const response = await policyApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent(attackerUrl)}`,
          headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("https://safe.example.com/");
      } finally {
        await policyApp.close();
      }
    },
  );

  it("no combination of isBot/bot/classification/score query parameters can change the Safe Page destination", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const attackerSafePage = "https://attacker.example/fake-safe-page";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}` +
        `&isBot=false&bot=false&classification=HUMAN&score=0` +
        `&safePageUrl=${encodeURIComponent(attackerSafePage)}`,
      { "user-agent": BOT_UA },
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });
});

describe("detection failure isolation and safe fallback (Phase 5)", () => {
  it("still redirects (per the UNKNOWN policy default) when the BotDetectionEngine throws synchronously", async () => {
    const throwingEngineApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: {
        classify: () => {
          throw new Error("boom: detection engine exploded");
        },
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await throwingEngineApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);

      const click = await prisma.click.findFirstOrThrow({
        where: { trackingLinkId: fixture.trackingLinkId },
      });
      expect(click.botClassification).toBe("UNKNOWN");

      const botEvent = await prisma.botEvent.findFirstOrThrow({ where: { clickId: click.id } });
      expect(botEvent.reasonCodes).toContain("detection_engine_failure");
      expect(botEvent.detectionSource).toBe("tracker-fallback");
    } finally {
      await throwingEngineApp.close();
    }
  });

  it("still redirects when the BotDetectionEngine's promise rejects", async () => {
    const rejectingEngineApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: {
        classify: () => Promise.reject(new Error("boom: detection engine rejected")),
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await rejectingEngineApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);
    } finally {
      await rejectingEngineApp.close();
    }
  });

  it("still redirects, without hanging, when the BotDetectionEngine never resolves", async () => {
    const hangingEngineApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: {
        classify: () =>
          new Promise(() => {
            /* deliberately never settles */
          }),
      },
    });
    try {
      const fixture = await createTrackerFixture();
      const target = "https://example.com/offer";
      const response = await hangingEngineApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);

      const click = await prisma.click.findFirstOrThrow({
        where: { trackingLinkId: fixture.trackingLinkId },
      });
      const botEvent = await prisma.botEvent.findFirstOrThrow({ where: { clickId: click.id } });
      expect(botEvent.reasonCodes).toContain("detection_engine_timeout");
    } finally {
      await hangingEngineApp.close();
    }
  });
});

describe("Click/BotEvent persistence consistency for non-HUMAN/BOT classifications (Phase 5)", () => {
  it("writes matching Click and BotEvent rows for a SUSPICIOUS verdict", async () => {
    const policyApp = await buildTrackerApp({
      env: getEnv(),
      logger: false,
      botDetectionEngine: fixedClassificationEngine("SUSPICIOUS", ["test_reason_a", "test_reason_b"]),
    });
    try {
      const fixture = await createTrackerFixture();
      const response = await policyApp.inject({
        method: "GET",
        url: `/${fixture.slug}?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
        headers: { host: fixture.hostname, "user-agent": HUMAN_UA },
      });
      expect(response.statusCode).toBe(302);

      const click = await prisma.click.findFirstOrThrow({
        where: { trackingLinkId: fixture.trackingLinkId },
      });
      expect(click.botClassification).toBe("SUSPICIOUS");
      expect(click.botScore).toBe(0.5);

      const botEvent = await prisma.botEvent.findFirstOrThrow({ where: { clickId: click.id } });
      expect(botEvent.classification).toBe("SUSPICIOUS");
      expect(botEvent.score).toBe(0.5);
      expect(botEvent.reasonCodes).toEqual(["test_reason_a", "test_reason_b"]);
      expect(botEvent.detectionSource).toBe("fixed-fake");
    } finally {
      await policyApp.close();
    }
  });
});

describe("malicious/conflicting headers and query parameters (Phase 5)", () => {
  it("a known-bot User-Agent combined with a fully browser-consistent header set is still classified BOT", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    // hit() already sends REALISTIC_BROWSER_HEADERS by default; overriding
    // only the User-Agent to a known bot simulates a script that copied a
    // real browser's full header set but kept (or forgot to spoof) its own
    // automation UA.
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      { "user-agent": BOT_UA },
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("arbitrary client-supplied headers outside the allowed detection set have no effect on classification", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      {
        "user-agent": BOT_UA,
        "x-bot-override": "false",
        "x-forwarded-classification": "HUMAN",
        "x-detection-score": "0",
      },
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("conflicting sec-fetch header values (present but nonsensical) are still treated as headers being present", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer";
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
      { "user-agent": HUMAN_UA, "sec-fetch-mode": "not-a-real-value" },
    );
    // Presence, not semantic validity, is what the heuristic checks — a
    // genuine browser's own values are trusted the same way; asserting
    // this stays HUMAN documents that the engine doesn't try to validate
    // header contents beyond presence.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });
});

describe("Rules & Routing Engine (Phase 8)", () => {
  it("a matching rule routes HUMAN traffic to SAFE_PAGE, overriding the campaign's TARGET default", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "SAFE_PAGE",
      conditions: [],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("a matching rule routes HUMAN traffic to BLOCK, returning a controlled 404", async () => {
    const fixture = await createTrackerFixture();
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "BLOCK",
      conditions: [],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
    );
    expect(response.statusCode).toBe(404);
  });

  it("a matching TARGET rule still follows the request's own transparent redirection_url, never a rule-configured URL (Phase 3 safety)", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer?utm_source=ad";
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "TARGET",
      conditions: [{ field: "DEVICE_TYPE", operator: "NOT_EQUALS", value: "TABLET" }],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("a non-matching rule falls through to the campaign's default (TARGET) for HUMAN traffic", async () => {
    const fixture = await createTrackerFixture();
    const target = "https://example.com/offer";
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "BLOCK",
      conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    // No CDN geo header is present in this test request, so `country` is
    // null and the COUNTRY condition never matches (see
    // packages/shared/src/routing-rules.ts's fail-closed-on-unknown
    // behavior) — the rule is correctly skipped.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  describe("COUNTRY trust boundary (PR #9 review: spoofing resistance)", () => {
    it("a direct client sending cf-ipcountry cannot make a COUNTRY rule match when no trusted-edge secret is configured", async () => {
      // Uses the default `app` from beforeEach — buildTrackerApp() with no
      // trustedEdgeSecret override, i.e. TRUSTED_EDGE_SECRET unset, the
      // documented fail-closed default.
      const fixture = await createTrackerFixture();
      await createRoutingRule(fixture.organizationId, fixture.campaignId, {
        action: "BLOCK",
        conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
      });

      const target = "https://example.com/offer";
      const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`, {
        "cf-ipcountry": "US",
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(target);
    });

    it.each(["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country"])(
      "a direct request spoofing %s alone (no secret configured) never matches a COUNTRY rule",
      async (headerName) => {
        const fixture = await createTrackerFixture();
        await createRoutingRule(fixture.organizationId, fixture.campaignId, {
          action: "BLOCK",
          conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        });

        const target = "https://example.com/offer";
        const response = await hit(fixture.hostname, fixture.slug, `?redirection_url=${encodeURIComponent(target)}`, {
          [headerName]: "US",
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(target);
      },
    );

    it("a client that spoofs the trusted-edge secret HEADER NAME with the wrong value still cannot make COUNTRY match, even on a deployment that HAS a secret configured", async () => {
      const secret = "test-trusted-edge-secret-0123456789";
      const trustedApp = await buildTrackerApp({ env: getEnv(), logger: false, trustedEdgeSecret: secret });
      try {
        const fixture = await createTrackerFixture();
        await createRoutingRule(fixture.organizationId, fixture.campaignId, {
          action: "BLOCK",
          conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        });

        const target = "https://example.com/offer";
        const response = await trustedApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
          headers: {
            host: fixture.hostname,
            "user-agent": HUMAN_UA,
            ...REALISTIC_BROWSER_HEADERS,
            "cf-ipcountry": "US",
            "x-adstrackio-edge-secret": "attacker-does-not-know-the-real-secret",
          },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(target);
      } finally {
        await trustedApp.close();
      }
    });

    it("a request carrying no secret header at all never matches COUNTRY, even on a deployment that HAS a secret configured", async () => {
      const secret = "test-trusted-edge-secret-0123456789";
      const trustedApp = await buildTrackerApp({ env: getEnv(), logger: false, trustedEdgeSecret: secret });
      try {
        const fixture = await createTrackerFixture();
        await createRoutingRule(fixture.organizationId, fixture.campaignId, {
          action: "BLOCK",
          conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        });

        const target = "https://example.com/offer";
        const response = await trustedApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent(target)}`,
          headers: {
            host: fixture.hostname,
            "user-agent": HUMAN_UA,
            ...REALISTIC_BROWSER_HEADERS,
            "cf-ipcountry": "US",
          },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(target);
      } finally {
        await trustedApp.close();
      }
    });

    it("a request carrying the exact matching trusted-edge secret DOES let a COUNTRY rule match — the boundary works both ways", async () => {
      const secret = "test-trusted-edge-secret-0123456789";
      const trustedApp = await buildTrackerApp({ env: getEnv(), logger: false, trustedEdgeSecret: secret });
      try {
        const fixture = await createTrackerFixture();
        await createRoutingRule(fixture.organizationId, fixture.campaignId, {
          action: "BLOCK",
          conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "US" }],
        });

        const response = await trustedApp.inject({
          method: "GET",
          url: `/${fixture.slug}?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
          headers: {
            host: fixture.hostname,
            "user-agent": HUMAN_UA,
            ...REALISTIC_BROWSER_HEADERS,
            "cf-ipcountry": "US",
            "x-adstrackio-edge-secret": secret,
          },
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await trustedApp.close();
      }
    });
  });

  it("BOT traffic is never subject to a routing rule, even one unconditionally matching everything", async () => {
    const fixture = await createTrackerFixture({ safePageUrl: "https://safe.example.com/" });
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "TARGET",
      conditions: [],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      { "user-agent": BOT_UA },
    );
    // BOT_POLICY precedence wins unconditionally: SAFE_PAGE, never the
    // rule's TARGET action.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://safe.example.com/");
  });

  it("evaluates rules in ascending priority order — the lower-numbered rule wins when both match", async () => {
    const fixture = await createTrackerFixture();
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      priority: 5,
      action: "BLOCK",
      conditions: [],
      name: "low priority",
    });
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      priority: 1,
      action: "TARGET",
      conditions: [],
      name: "high priority",
    });

    const target = "https://example.com/offer";
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("an INACTIVE rule is never evaluated", async () => {
    const fixture = await createTrackerFixture();
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "BLOCK",
      conditions: [],
      status: "INACTIVE",
    });

    const target = "https://example.com/offer";
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("a rule on a different campaign is never evaluated for this campaign's traffic (isolation)", async () => {
    const fixtureA = await createTrackerFixture();
    const fixtureB = await createTrackerFixture();
    await createRoutingRule(fixtureB.organizationId, fixtureB.campaignId, {
      action: "BLOCK",
      conditions: [],
    });

    const target = "https://example.com/offer";
    const response = await hit(
      fixtureA.hostname,
      fixtureA.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  });

  it("matches a DEVICE_TYPE condition derived from the User-Agent", async () => {
    const fixture = await createTrackerFixture();
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "BLOCK",
      conditions: [{ field: "DEVICE_TYPE", operator: "EQUALS", value: "MOBILE" }],
    });
    const mobileUa =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      { "user-agent": mobileUa },
    );
    expect(response.statusCode).toBe(404);
  });

  it("matches a REFERRER_HOST condition derived from the Referer header", async () => {
    const fixture = await createTrackerFixture();
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      action: "BLOCK",
      conditions: [{ field: "REFERRER_HOST", operator: "EQUALS", value: "malicious-referrer.example" }],
    });

    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent("https://example.com/offer")}`,
      { referer: "https://malicious-referrer.example/page" },
    );
    expect(response.statusCode).toBe(404);
  });

  it("a rule beyond the resolver's MAX_ACTIVE_RULES_PER_CAMPAIGN bound is never fetched or evaluated", async () => {
    const fixture = await createTrackerFixture();
    // Create exactly 50 unconditional-non-matching rules at priorities
    // 1-50 (all TARGET, so even if evaluated they wouldn't change the
    // outcome), then one more at priority 51 that WOULD match and BLOCK
    // if it were ever considered. The resolver's `take: 50` ordered by
    // priority ascending must exclude it.
    for (let priority = 1; priority <= 50; priority += 1) {
      await createRoutingRule(fixture.organizationId, fixture.campaignId, {
        priority,
        action: "TARGET",
        conditions: [{ field: "COUNTRY", operator: "EQUALS", value: "ZZ" }], // never matches
        name: `filler ${priority}`,
      });
    }
    await createRoutingRule(fixture.organizationId, fixture.campaignId, {
      priority: 51,
      action: "BLOCK",
      conditions: [],
      name: "beyond bound",
    });

    const target = "https://example.com/offer";
    const response = await hit(
      fixture.hostname,
      fixture.slug,
      `?redirection_url=${encodeURIComponent(target)}`,
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(target);
  }, 30_000);
});
