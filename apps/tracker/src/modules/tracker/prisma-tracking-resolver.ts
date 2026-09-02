import type { PrismaClient } from "@adstrackio/database";
import {
  TrackingResolutionError,
  type TrackingResolutionRequest,
  type TrackingResolutionResult,
  type TrackingResolver,
} from "@adstrackio/shared";

/**
 * Real (Phase 3) implementation of TrackingResolver, backed by Postgres.
 *
 * Resolution order and why: hostname -> TrackingDomain first, because an
 * unknown/unverified/inactive domain must reject the request before ever
 * looking at the slug — this is what keeps a domain someone hasn't proven
 * ownership of (or has deactivated) from serving traffic at all,
 * independent of what tracking links exist on it (Phase 2's activation
 * invariant, reused rather than re-implemented here).
 *
 * Both lookups use the existing unique indexes (`TrackingDomain.hostname`,
 * `TrackingLink.(trackingDomainId, slug)`), so this is two point lookups
 * on the hot path, not a scan or a join across unrelated tables.
 */
export class PrismaTrackingResolver implements TrackingResolver {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(request: TrackingResolutionRequest): Promise<TrackingResolutionResult> {
    const domain = await this.prisma.trackingDomain.findUnique({
      where: { hostname: request.hostname },
    });

    if (!domain) {
      throw new TrackingResolutionError(
        "domain_not_found",
        `No tracking domain registered for hostname "${request.hostname}"`,
      );
    }
    if (domain.verificationStatus !== "VERIFIED") {
      throw new TrackingResolutionError(
        "domain_not_verified",
        "Tracking domain has not completed DNS verification",
      );
    }
    if (!domain.isActive) {
      throw new TrackingResolutionError("domain_inactive", "Tracking domain is not active");
    }

    const link = await this.prisma.trackingLink.findUnique({
      where: { trackingDomainId_slug: { trackingDomainId: domain.id, slug: request.slug } },
      include: { campaign: true },
    });

    if (!link) {
      throw new TrackingResolutionError(
        "link_not_found",
        `No tracking link "${request.slug}" on this domain`,
      );
    }
    if (link.status !== "ACTIVE") {
      throw new TrackingResolutionError("link_inactive", "Tracking link is not active");
    }

    // Defense-in-depth org-isolation check: apps/api's createTrackingLink
    // already guarantees campaign/domain/destination share an
    // organizationId at write time (assertOwnedByOrg), so this should be
    // unreachable in practice. It stays here so a resolver bug or a future
    // data migration mistake can never let one organization's tracking
    // link resolve through another organization's domain.
    if (link.campaign.organizationId !== domain.organizationId) {
      throw new TrackingResolutionError(
        "link_not_found",
        "Tracking link does not belong to this domain's organization",
      );
    }

    return {
      trackingLinkId: link.id,
      campaignId: link.campaignId,
      organizationId: domain.organizationId,
      safePageUrl: link.campaign.safePageUrl,
    };
  }
}
