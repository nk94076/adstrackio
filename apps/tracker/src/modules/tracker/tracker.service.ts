import type { PrismaClient } from "@adstrackio/database";
import {
  UNKNOWN_DEVICE_INFO,
  UNKNOWN_GEO_LOCATION,
  type BotClassificationResult,
  type DeviceInfo,
  type GeoLocationProvider,
  type GeoLocationResult,
  type UserAgentParser,
} from "@adstrackio/shared";

export interface RecordClickInput {
  id: string;
  organizationId: string;
  campaignId: string;
  trackingLinkId: string;
  userAgent?: string;
  referrer?: string;
  ipHash: string;
  /** The request's raw IP, used ONLY transiently for the geo lookup below
   * (never written to the database — see recordClick's doc comment). */
  ip: string;
  classification: BotClassificationResult;
}

export interface RecordClickDependencies {
  userAgentParser: UserAgentParser;
  geoLocationProvider: GeoLocationProvider;
}

/**
 * Never let optional analytics enrichment fail the click write (and, by
 * extension, the redirect that depends on it completing) — UA parsing is
 * pure/synchronous so a throw here would mean a bug in the parser, and a
 * geo provider is arbitrary third-party code once one is configured. Both
 * are wrapped so any failure degrades to "unknown" instead of propagating.
 */
function safeParseUserAgent(parser: UserAgentParser, userAgent: string | undefined): DeviceInfo {
  try {
    return parser.parse(userAgent);
  } catch {
    return UNKNOWN_DEVICE_INFO;
  }
}

async function safeLookupGeo(
  provider: GeoLocationProvider,
  ip: string,
): Promise<GeoLocationResult> {
  try {
    return await provider.lookup(ip);
  } catch {
    return UNKNOWN_GEO_LOCATION;
  }
}

/**
 * Looks up geo data and applies it to an already-written Click row, without
 * the caller ever awaiting this function. A GeoLocationProvider is
 * arbitrary code once one is configured (a network call to a remote geo
 * service, in the expected real-world case) — it must never add latency to
 * the redirect response, not even the latency of a *successful* lookup, so
 * this deliberately runs after recordClick has already returned rather than
 * being awaited inline. safeLookupGeo already reduces a throw/rejection to
 * UNKNOWN_GEO_LOCATION; the outer catch here exists only to guarantee no
 * unhandled rejection from the follow-up `update` itself (e.g. a dropped DB
 * connection, or the click row having been deleted in the meantime).
 */
function enrichClickWithGeoInBackground(
  prisma: PrismaClient,
  clickId: string,
  ip: string,
  provider: GeoLocationProvider,
): void {
  void safeLookupGeo(provider, ip)
    .then((geo) => {
      if (!geo.country && !geo.region && !geo.city && !geo.timezone) {
        return undefined;
      }
      return prisma.click.update({
        where: { id: clickId },
        data: {
          country: geo.country ?? undefined,
          region: geo.region ?? undefined,
          city: geo.city ?? undefined,
          timezone: geo.timezone ?? undefined,
        },
      });
    })
    .catch(() => {
      // Swallow: geo enrichment is best-effort and must never surface as an
      // unhandled rejection outside the click/redirect that triggered it.
    });
}

/**
 * Writes the Click row and its corresponding BotEvent in one transaction.
 * BotEvent remains the source of truth for a classification; Click carries
 * a denormalized snapshot (botClassification/botScore) purely for fast
 * read-path filtering — this mirrors the split already documented in
 * docs/architecture/data-model.md, not a new design.
 *
 * Phase 4 enrichment: browser/browserVersion/os/osVersion/deviceType come
 * from UserAgentParser and are written synchronously in the same
 * transaction as the Click row — UA parsing is a pure, local, synchronous
 * string-matching operation (see packages/shared/src/user-agent.ts), so it
 * carries no latency risk.
 *
 * country/region/city/timezone come from GeoLocationProvider (a no-op by
 * default — see packages/shared/src/geo-location.ts) and are handled very
 * differently: the caller of recordClick (the redirect route handler) must
 * never wait on a geo lookup, since a real provider is expected to be a
 * network call. The Click row is written first with geo fields left null,
 * and `enrichClickWithGeoInBackground` is fired without being awaited — its
 * promise keeps running after recordClick has already resolved (and, in
 * the route handler, after the redirect has already been sent) and applies
 * geo data with a follow-up UPDATE if/when the provider resolves.
 *
 * For a classification of BOT, the stored deviceType stays "BOT" (a much
 * more useful analytics signal than a UA-derived guess) rather than being
 * overwritten by the parser.
 */
export async function recordClick(
  prisma: PrismaClient,
  input: RecordClickInput,
  deps: RecordClickDependencies,
) {
  const deviceInfo = safeParseUserAgent(deps.userAgentParser, input.userAgent);

  const click = await prisma.$transaction(async (tx) => {
    const click = await tx.click.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        trackingLinkId: input.trackingLinkId,
        userAgent: input.userAgent,
        referrer: input.referrer,
        ipHash: input.ipHash,
        deviceType: input.classification.classification === "BOT" ? "BOT" : deviceInfo.deviceType,
        browser: deviceInfo.browser ?? undefined,
        browserVersion: deviceInfo.browserVersion ?? undefined,
        os: deviceInfo.os ?? undefined,
        osVersion: deviceInfo.osVersion ?? undefined,
        botClassification: input.classification.classification,
        botScore: input.classification.score,
      },
    });

    await tx.botEvent.create({
      data: {
        clickId: click.id,
        classification: input.classification.classification,
        score: input.classification.score,
        reasonCodes: input.classification.reasonCodes,
        detectionSource: input.classification.detectionSource,
      },
    });

    return click;
  });

  enrichClickWithGeoInBackground(prisma, click.id, input.ip, deps.geoLocationProvider);

  return click;
}
