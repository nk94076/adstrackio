import type { PrismaClient, Prisma } from "@adstrackio/database";
import { ApiError, MAX_ACTIVE_RULES_PER_CAMPAIGN } from "@adstrackio/shared";
import type { CreateRoutingRuleInput, UpdateRoutingRuleInput } from "@adstrackio/validation";
import { writeAuditLog } from "../audit-logs/audit-log.service.js";
import { getCampaign } from "../campaigns/campaigns.service.js";

/**
 * Routing rule control plane (Phase 8: Rules & Routing Engine) — manages
 * the RoutingRule rows apps/tracker's PrismaTrackingResolver reads and
 * packages/shared's evaluateRules/resolveRoutingDecision act on. See
 * docs/architecture/rules-routing.md for the full design.
 *
 * organizationId/campaignId are never taken from the request body — only
 * from the authenticated, membership-checked URL path
 * (/organizations/:organizationId/campaigns/:campaignId/rules/...), the
 * same IDOR boundary every other nested-resource module in this codebase
 * (tracking-links, conversions) already enforces. The database additionally
 * backstops this via `enforce_routing_rule_campaign_organization` (see the
 * Phase 8 migration) in case a future code path bypasses this service.
 */

async function countActiveRoutingRules(
  prisma: PrismaClient | Prisma.TransactionClient,
  campaignId: string,
): Promise<number> {
  return prisma.routingRule.count({ where: { campaignId, status: "ACTIVE" } });
}

/**
 * Advisory, not a hard security invariant: this check-then-act has a
 * narrow TOCTOU window under two concurrent activate/create calls (both
 * could read a count under the limit before either commits). That's an
 * acceptable, deliberate trade-off here — unlike Conversion's
 * approve/reject/reverse (PR #8's review explicitly required provable
 * same-target concurrency), a rule count briefly landing at 51 instead of
 * 50 has no correctness impact: evaluateRules independently and
 * unconditionally re-bounds to MAX_ACTIVE_RULES_PER_CAMPAIGN by priority
 * order at read time (packages/shared/src/routing-rules.ts) regardless of
 * how many ACTIVE rows actually exist, so the tracker's hot path is safe
 * either way. This check exists to give an operator a clear error instead
 * of a rule that silently never gets evaluated because it fell outside
 * the bound.
 */
async function assertActiveRuleBudgetAvailable(
  prisma: PrismaClient | Prisma.TransactionClient,
  campaignId: string,
): Promise<void> {
  const activeCount = await countActiveRoutingRules(prisma, campaignId);
  if (activeCount >= MAX_ACTIVE_RULES_PER_CAMPAIGN) {
    throw ApiError.conflict(
      `This campaign already has ${MAX_ACTIVE_RULES_PER_CAMPAIGN} ACTIVE routing rules, the maximum evaluateRules will consider — deactivate or delete one before activating another`,
    );
  }
}

function mapPriorityConflict(error: unknown, campaignId: string, priority: number): never {
  if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
    throw ApiError.conflict(
      `A routing rule with priority ${priority} already exists for campaign ${campaignId}`,
    );
  }
  throw error as Error;
}

export async function createRoutingRule(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  input: CreateRoutingRuleInput,
) {
  await getCampaign(prisma, organizationId, campaignId);

  if (input.status === "ACTIVE") {
    await assertActiveRuleBudgetAvailable(prisma, campaignId);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const rule = await tx.routingRule.create({
        data: {
          organizationId,
          campaignId,
          name: input.name,
          status: input.status,
          priority: input.priority,
          conditions: input.conditions as unknown as Prisma.InputJsonValue,
          action: input.action,
        },
      });

      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "routing_rule.created",
        entityType: "RoutingRule",
        entityId: rule.id,
        metadata: { campaignId, name: rule.name, priority: rule.priority, status: rule.status },
      });

      return rule;
    });
  } catch (error) {
    mapPriorityConflict(error, campaignId, input.priority);
  }
}

export async function listRoutingRulesForCampaign(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
) {
  await getCampaign(prisma, organizationId, campaignId);
  return prisma.routingRule.findMany({
    where: { campaignId, organizationId },
    orderBy: { priority: "asc" },
  });
}

export async function getRoutingRule(
  prisma: PrismaClient,
  organizationId: string,
  campaignId: string,
  ruleId: string,
) {
  const rule = await prisma.routingRule.findFirst({
    where: { id: ruleId, campaignId, organizationId },
  });
  if (!rule) {
    throw ApiError.notFound("Routing rule not found");
  }
  return rule;
}

export async function updateRoutingRule(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  ruleId: string,
  input: UpdateRoutingRuleInput,
) {
  await getRoutingRule(prisma, organizationId, campaignId, ruleId);

  try {
    return await prisma.$transaction(async (tx) => {
      const rule = await tx.routingRule.update({
        where: { id: ruleId },
        data: {
          name: input.name,
          priority: input.priority,
          conditions: input.conditions as unknown as Prisma.InputJsonValue | undefined,
          action: input.action,
        },
      });

      await writeAuditLog(tx, {
        organizationId,
        actorUserId,
        action: "routing_rule.updated",
        entityType: "RoutingRule",
        entityId: rule.id,
      });

      return rule;
    });
  } catch (error) {
    mapPriorityConflict(error, campaignId, input.priority ?? -1);
  }
}

export async function deleteRoutingRule(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  ruleId: string,
) {
  await getRoutingRule(prisma, organizationId, campaignId, ruleId);

  await prisma.$transaction(async (tx) => {
    await tx.routingRule.delete({ where: { id: ruleId } });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: "routing_rule.deleted",
      entityType: "RoutingRule",
      entityId: ruleId,
      metadata: { campaignId },
    });
  });
}

/**
 * Shared by activateRoutingRule/deactivateRoutingRule. RoutingRuleStatus is
 * a plain two-state toggle (unlike Campaign/TrackingLink/Conversion's
 * larger state machines, there is no illegal transition to reject — both
 * directions are always legal), so there's no assertValid*StatusTransition
 * check to reuse here.
 *
 * Uses the same `SELECT ... FOR UPDATE` row-lock pattern
 * conversions.service.ts's transitionConversionStatus settled on (PR #8's
 * review), not a conditional-updateMany: a conditional-updateMany guarded
 * on "the status I read a moment ago" cannot prove idempotency for two
 * concurrent calls that both want the SAME target status (e.g.
 * activate+activate on an INACTIVE rule) — exactly one would win the
 * updateMany and the other would see count===0 and incorrectly 409, even
 * though both callers asked for exactly the state the row ends up in.
 * Locking the row first and re-reading its status AFTER the lock is held
 * means the loser of the race observes the winner's already-committed
 * result before deciding, so "already at target" is correctly treated as
 * idempotent success no matter which caller's write physically happened
 * first.
 */
async function transitionRoutingRuleStatus(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  ruleId: string,
  targetStatus: "ACTIVE" | "INACTIVE",
  auditAction: string,
) {
  await getRoutingRule(prisma, organizationId, campaignId, ruleId);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: "ACTIVE" | "INACTIVE" }[]>`
      SELECT status FROM routing_rules
      WHERE id = ${ruleId} AND "organizationId" = ${organizationId} AND "campaignId" = ${campaignId}
      FOR UPDATE
    `;
    const currentStatus = locked[0]?.status;
    if (!currentStatus) {
      throw ApiError.notFound("Routing rule not found");
    }

    if (currentStatus === targetStatus) {
      return tx.routingRule.findUniqueOrThrow({ where: { id: ruleId } });
    }

    if (targetStatus === "ACTIVE") {
      await assertActiveRuleBudgetAvailable(tx, campaignId);
    }

    const updated = await tx.routingRule.update({
      where: { id: ruleId },
      data: { status: targetStatus },
    });

    await writeAuditLog(tx, {
      organizationId,
      actorUserId,
      action: auditAction,
      entityType: "RoutingRule",
      entityId: ruleId,
      metadata: { campaignId, from: currentStatus, to: targetStatus },
    });

    return updated;
  });
}

export function activateRoutingRule(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  ruleId: string,
) {
  return transitionRoutingRuleStatus(
    prisma,
    actorUserId,
    organizationId,
    campaignId,
    ruleId,
    "ACTIVE",
    "routing_rule.activated",
  );
}

export function deactivateRoutingRule(
  prisma: PrismaClient,
  actorUserId: string,
  organizationId: string,
  campaignId: string,
  ruleId: string,
) {
  return transitionRoutingRuleStatus(
    prisma,
    actorUserId,
    organizationId,
    campaignId,
    ruleId,
    "INACTIVE",
    "routing_rule.deactivated",
  );
}
