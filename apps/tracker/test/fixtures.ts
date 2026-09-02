import { randomUUID } from "node:crypto";
import { prisma } from "@adstrackio/database";
import type { TrackingLinkStatus } from "@adstrackio/database";

export interface TrackerFixture {
  organizationId: string;
  domainId: string;
  hostname: string;
  campaignId: string;
  destinationId: string;
  trackingLinkId: string;
  slug: string;
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
    },
  });

  const trackingLink = await prisma.trackingLink.create({
    data: {
      campaignId: campaign.id,
      trackingDomainId: domain.id,
      destinationId: destination.id,
      slug,
      status: linkStatus,
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
  };
}
