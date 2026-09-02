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
 * Writes the Click row and its corresponding BotEvent in one transaction.
 * BotEvent remains the source of truth for a classification; Click carries
 * a denormalized snapshot (botClassification/botScore) purely for fast
 * read-path filtering — this mirrors the split already documented in
 * docs/architecture/data-model.md, not a new design.
 *
 * Phase 4 enrichment: browser/browserVersion/os/osVersion/deviceType come
 * from UserAgentParser, and country/region/city/timezone from
 * GeoLocationProvider (a no-op by default — see
 * packages/shared/src/geo-location.ts). For a classification of BOT, the
 * stored deviceType stays "BOT" (a much more useful analytics signal than
 * a UA-derived guess) rather than being overwritten by the parser.
 */
export async function recordClick(
  prisma: PrismaClient,
  input: RecordClickInput,
  deps: RecordClickDependencies,
) {
  const deviceInfo = safeParseUserAgent(deps.userAgentParser, input.userAgent);
  const geo = await safeLookupGeo(deps.geoLocationProvider, input.ip);

  return prisma.$transaction(async (tx) => {
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
        country: geo.country ?? undefined,
        region: geo.region ?? undefined,
        city: geo.city ?? undefined,
        timezone: geo.timezone ?? undefined,
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
}
