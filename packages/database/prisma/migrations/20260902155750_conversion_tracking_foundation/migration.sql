-- Phase 7: Conversion Tracking foundation.
--
-- Conversion.trackingLinkId/clickId move from optional to required: every
-- conversion is now always attributed through a real Click (see
-- docs/architecture/conversion-tracking.md). The table has never had a
-- production writer (no service existed before this phase), so there is no
-- existing-row backfill concern here.
--
-- payoutAmount/payoutCurrency are renamed to value/currency to match this
-- phase's "conversion event value," distinct from a future affiliate
-- payout amount (Phase 9) — see the Conversion model's doc comment in
-- schema.prisma.

-- DropForeignKey
ALTER TABLE "conversions" DROP CONSTRAINT "conversions_clickId_fkey";

-- DropForeignKey
ALTER TABLE "conversions" DROP CONSTRAINT "conversions_trackingLinkId_fkey";

-- DropIndex
DROP INDEX "conversions_campaignId_idx";

-- DropIndex
DROP INDEX "conversions_trackingLinkId_idx";

-- AlterTable
ALTER TABLE "conversions" DROP COLUMN "payoutAmount",
DROP COLUMN "payoutCurrency",
ADD COLUMN     "currency" VARCHAR(3),
ADD COLUMN     "eventName" TEXT NOT NULL,
ADD COLUMN     "externalConversionId" TEXT,
ADD COLUMN     "value" DECIMAL(12,2),
ALTER COLUMN "trackingLinkId" SET NOT NULL,
ALTER COLUMN "clickId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "conversions_campaignId_occurredAt_idx" ON "conversions"("campaignId", "occurredAt");

-- CreateIndex
CREATE INDEX "conversions_trackingLinkId_occurredAt_idx" ON "conversions"("trackingLinkId", "occurredAt");

-- CreateIndex
CREATE INDEX "conversions_status_occurredAt_idx" ON "conversions"("status", "occurredAt");

-- CreateIndex: only applies to rows that actually supplied an
-- externalConversionId (Postgres treats each NULL as distinct for
-- uniqueness purposes) — see docs/architecture/conversion-tracking.md#deduplication.
CREATE UNIQUE INDEX "conversions_organizationId_externalConversionId_key" ON "conversions"("organizationId", "externalConversionId");

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_trackingLinkId_fkey" FOREIGN KEY ("trackingLinkId") REFERENCES "tracking_links"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_clickId_fkey" FOREIGN KEY ("clickId") REFERENCES "clicks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defense-in-depth for click-derived attribution.
--
-- The application (apps/api/src/modules/conversions/conversions.service.ts,
-- createConversion) already derives organizationId/campaignId/
-- trackingLinkId from the referenced Click and never accepts them as
-- client input. This trigger enforces the same invariant directly in
-- Postgres so a conversion's attribution can never disagree with its
-- click even for a write that bypasses the service layer entirely (a raw
-- SQL statement, a future admin tool, a bug) — mirrors the pattern
-- `enforce_referral_configuration_activation` established for the
-- referral-activation gate (migration
-- 20260901204759_enforce_referral_activation_gate). It also makes a
-- conversion's click/organization/campaign/tracking-link attribution
-- immutable after creation: there is no legitimate reason to repoint an
-- existing conversion at a different click.
CREATE OR REPLACE FUNCTION enforce_conversion_click_attribution()
RETURNS TRIGGER AS $$
DECLARE
  click_organization_id TEXT;
  click_campaign_id TEXT;
  click_tracking_link_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."clickId" IS DISTINCT FROM OLD."clickId"
      OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
      OR NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
      OR NEW."trackingLinkId" IS DISTINCT FROM OLD."trackingLinkId" THEN
      RAISE EXCEPTION
        'conversion % attribution (clickId/organizationId/campaignId/trackingLinkId) is immutable after creation',
        OLD.id
        USING ERRCODE = '23514'; -- check_violation
    END IF;
    RETURN NEW;
  END IF;

  SELECT "organizationId", "campaignId", "trackingLinkId"
    INTO click_organization_id, click_campaign_id, click_tracking_link_id
    FROM "clicks" WHERE id = NEW."clickId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversion references a nonexistent clickId %', NEW."clickId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."organizationId" IS DISTINCT FROM click_organization_id
    OR NEW."campaignId" IS DISTINCT FROM click_campaign_id
    OR NEW."trackingLinkId" IS DISTINCT FROM click_tracking_link_id THEN
    RAISE EXCEPTION
      'conversion attribution (organizationId/campaignId/trackingLinkId) must match its click %',
      NEW."clickId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_conversion_click_attribution
BEFORE INSERT OR UPDATE OF "clickId", "organizationId", "campaignId", "trackingLinkId" ON "conversions"
FOR EACH ROW
EXECUTE FUNCTION enforce_conversion_click_attribution();
