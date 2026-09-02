import type { PrismaClient } from "@adstrackio/database";
import {
  MAX_ACTIVE_RULES_PER_CAMPAIGN,
  TrackingResolutionError,
  type RoutingCondition,
  type RoutingRuleInput,
  type TrackingResolutionRequest,
  type TrackingResolutionResult,
  type TrackingResolver,
} from "@adstrackio/shared";

/**
 * Rules are already validated (typed fields/operators, bounded array
 * lengths) by packages/validation/src/routing-rules.ts at write time —
 * this cast trusts that invariant rather than re-validating a JSONB column
 * on every redirect, the same trust boundary conversions.service.ts
 * already extends to Conversion.metadata elsewhere in this codebase.
 */
function toRoutingRuleInput(row: {
  id: string;
  priority: number;
  conditions: unknown;
  action: string;
}): RoutingRuleInput {
  return {
    id: row.id,
    priority: row.priority,
    conditions: row.conditions as RoutingCondition[],
    action: row.action as RoutingRuleInput["action"],
  };
}

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

    // Bounded at the source (`take`), not just defensively re-bounded by
    // evaluateRules downstream — this keeps the query itself cheap under a
    // campaign with far more historical (mostly INACTIVE) rules than the
    // active limit. Ordered by priority so the list is already in
    // evaluation order by the time it reaches resolveRoutingDecision.
    const routingRules = await this.prisma.routingRule.findMany({
      where: { campaignId: link.campaignId, status: "ACTIVE" },
      orderBy: { priority: "asc" },
      take: MAX_ACTIVE_RULES_PER_CAMPAIGN,
      select: { id: true, priority: true, conditions: true, action: true },
    });

    return {
      trackingLinkId: link.id,
      campaignId: link.campaignId,
      organizationId: domain.organizationId,
      safePageUrl: link.campaign.safePageUrl,
      botTrafficPolicy: {
        suspiciousTrafficPolicy: link.campaign.suspiciousTrafficPolicy,
        unknownTrafficPolicy: link.campaign.unknownTrafficPolicy,
      },
      routingRules: routingRules.map(toRoutingRuleInput),
      // Free — link.affiliatePartnerId is already present on the row the
      // findUnique above fetched (Phase 9: Affiliate/Partner System), no
      // extra query. See docs/architecture/affiliate-partners.md#tracker-performance.
      affiliatePartnerId: link.affiliatePartnerId,
    };
  }
}
