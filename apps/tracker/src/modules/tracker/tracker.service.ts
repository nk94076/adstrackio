import type { PrismaClient } from "@adstrackio/database";
import type { BotClassificationResult } from "@adstrackio/shared";

export interface RecordClickInput {
  id: string;
  organizationId: string;
  campaignId: string;
  trackingLinkId: string;
  userAgent?: string;
  referrer?: string;
  ipHash: string;
  classification: BotClassificationResult;
}

/**
 * Writes the Click row and its corresponding BotEvent in one transaction.
 * BotEvent remains the source of truth for a classification; Click carries
 * a denormalized snapshot (botClassification/botScore) purely for fast
 * read-path filtering — this mirrors the split already documented in
 * docs/architecture/data-model.md, not a new design.
 *
 * Deliberately NOT populated here: browser/os/deviceType (beyond BOT) and
 * geo (country/region/city). There is no user-agent-parsing or
 * geo-lookup capability anywhere in this codebase yet, and building one is
 * Phase 4 (Click Analytics) work, not Phase 3's — see
 * docs/architecture/data-model.md for that split. Adding a fake/guessed
 * value here would be worse than leaving the column null.
 */
export async function recordClick(prisma: PrismaClient, input: RecordClickInput) {
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
        deviceType: input.classification.classification === "BOT" ? "BOT" : undefined,
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
