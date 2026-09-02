import { randomUUID } from "node:crypto";
import { prisma } from "@adstrackio/database";
import type { BotTrafficPolicyAction, TrackingLinkStatus } from "@adstrackio/database";

export interface TrackerFixture {
  organizationId: string;
  domainId: string;
  hostname: string;
  campaignId: string;
  destinationId: string;
  trackingLinkId: string;
  slug: string;
  /** Set only when `withAffiliatePartner` was requested (Phase 9:
   * Affiliate/Partner System) — the partner the fixture's TrackingLink
   * deterministically attributes to, already on the campaign's roster. */
  affiliatePartnerId: string | null;
}

export interface CreateTrackerFixtureOptions {
  hostname?: string;
  slug?: string;
  /** Defaults to true (verified). */
  domainVerified?: boolean;
  /** Defaults to true (active). Forced false if domainVerified is false —
   * the database's activation invariant makes that combination impossible. */
  domainActive?: boolean;
  linkStatus?: TrackingLinkStatus;
  safePageUrl?: string | null;
  /** Defaults to TARGET (see Campaign.suspiciousTrafficPolicy). */
  suspiciousTrafficPolicy?: BotTrafficPolicyAction;
  /** Defaults to TARGET (see Campaign.unknownTrafficPolicy). */
  unknownTrafficPolicy?: BotTrafficPolicyAction;
  /** Phase 9: Affiliate/Partner System — when true, creates an
   * AffiliatePartner, assigns it to the fixture's campaign roster, and
   * attributes the fixture's TrackingLink to it. Defaults to false (an
   * ordinary non-affiliate link, affiliatePartnerId null). */
  withAffiliatePartner?: boolean;
}

/**
 * Creates a full, valid Organization -> TrackingDomain -> Campaign ->
 * Destination -> TrackingLink chain directly via Prisma, bypassing
 * apps/api entirely. apps/tracker has no CRUD endpoints of its own — its
 * only job is to resolve traffic against data organizations already
 * configured through the control plane — so its tests set up fixtures the
 * same way apps/api's services would, minus the HTTP layer.
 */
export async function createTrackerFixture(
  options: CreateTrackerFixtureOptions = {},
): Promise<TrackerFixture> {
  const unique = randomUUID().slice(0, 8);
  const hostname = options.hostname ?? `track-${unique}.example.com`;
  const slug = options.slug ?? `slug-${unique}`;
  const domainVerified = options.domainVerified ?? true;
  const domainActive = (options.domainActive ?? true) && domainVerified;
  const linkStatus = options.linkStatus ?? "ACTIVE";

  const organization = await prisma.organization.create({
    data: { name: `Org ${unique}`, slug: `org-${unique}` },
  });

  const domain = await prisma.trackingDomain.create({
    data: {
      organizationId: organization.id,
      hostname,
      verificationStatus: domainVerified ? "VERIFIED" : "PENDING",
      verifiedAt: domainVerified ? new Date() : null,
      isActive: domainActive,
    },
  });

  const destination = await prisma.destination.create({
    data: {
      organizationId: organization.id,
      name: "Fixture Destination",
      url: "https://backend-configured-destination.example.com/",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      name: "Fixture Campaign",
      safePageUrl: options.safePageUrl ?? null,
      suspiciousTrafficPolicy: options.suspiciousTrafficPolicy ?? "TARGET",
      unknownTrafficPolicy: options.unknownTrafficPolicy ?? "TARGET",
    },
  });

  let affiliatePartnerId: string | null = null;
  if (options.withAffiliatePartner) {
    const partner = await prisma.affiliatePartner.create({
      data: { organizationId: organization.id, name: "Fixture Affiliate Partner", status: "ACTIVE" },
    });
    await prisma.campaignAffiliatePartner.create({
      data: { organizationId: organization.id, campaignId: campaign.id, affiliatePartnerId: partner.id },
    });
    affiliatePartnerId = partner.id;
  }

  const trackingLink = await prisma.trackingLink.create({
    data: {
      campaignId: campaign.id,
      trackingDomainId: domain.id,
      destinationId: destination.id,
      slug,
      status: linkStatus,
      affiliatePartnerId,
    },
  });

  return {
    organizationId: organization.id,
    domainId: domain.id,
    hostname,
    campaignId: campaign.id,
    destinationId: destination.id,
    trackingLinkId: trackingLink.id,
    slug,
    affiliatePartnerId,
  };
}
